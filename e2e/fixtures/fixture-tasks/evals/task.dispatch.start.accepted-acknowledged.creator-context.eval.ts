import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { equals } from "eve/evals/expect";

import type { LifecycleControlEvent } from "../agent/lib/lifecycle-control.js";
import {
  requireSessionStreamIndex,
  waitForTaskNotification,
  type TaskEvalSessionDriver,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const ALICE_AUTHORIZATION = "Bearer e2e-task-operation-a";
const BOB_AUTHORIZATION = "Bearer e2e-task-operation-b";

export default defineTaskEval({
  description:
    "A delayed task-owned subagent keeps its creator's authentication after another caller starts a parent turn.",
  transition: {
    primary: "task.dispatch.start.accepted-acknowledged",
    dimensions: { transport: "local" },
  },
  async test(t) {
    const key = crypto.randomUUID();
    const started = await t.send(`TASK-AUTH-SNAPSHOT ${key}`, {
      headers: { authorization: ALICE_AUTHORIZATION },
    });
    started.expectOk();
    started.messageIncludes("TASK-AUTH-SNAPSHOT-STARTED");
    const receipt = started.requireToolCall("lifecycle_task").output;
    if (
      receipt === null ||
      typeof receipt !== "object" ||
      typeof Reflect.get(receipt, "taskId") !== "string"
    ) {
      throw new Error("Auth snapshot task returned no background receipt.");
    }
    const taskId = Reflect.get(receipt, "taskId") as string;
    const sessionId = started.sessionId;
    if (sessionId === undefined) throw new Error("Auth snapshot task has no parent session id.");

    const owner = await lifecycleEvent(t, sessionId, key, 0);
    await t.require(
      { kind: owner.kind, marker: owner.marker, sessionId: owner.sessionId },
      equals({ kind: "owner", marker: "A", sessionId }),
    );
    const gate = await lifecycleEvent(t, sessionId, key, 1);
    if (gate.kind !== "gate" || gate.marker !== "A" || gate.token === undefined) {
      throw new Error("Auth snapshot task did not reach its pre-dispatch gate.");
    }

    const bob = await t.send(`TASK-AUTH-SNAPSHOT-BOB ${key}`, {
      headers: { authorization: BOB_AUTHORIZATION },
    });
    bob.expectOk();
    bob.messageIncludes("TASK-AUTH-SNAPSHOT-BOB-ACK");
    bob.usedNoTools();

    await releaseGate(t, sessionId, key, gate.token);
    const dispatched = await waitForSubagentDispatch(t, t);
    const child = await t.target.watchTurn(dispatched.childSessionId).result();
    child.expectOk();
    child.noFailedActions();
    child.calledTool("snapshot_whoami", { count: 1, status: "completed" });
    await t.require(
      child.requireToolCall("snapshot_whoami").output,
      equals({ current: "operation-user-a", initiator: "operation-user-a" }),
    );

    const completed = await waitForTaskNotification(
      t,
      dispatched.session,
      taskId,
      "completed",
      dispatched.turns,
    );
    completed.turn.noFailedActions();
  },
});

async function lifecycleEvent(
  t: EveEvalContext,
  sessionId: string,
  key: string,
  index: number,
): Promise<LifecycleControlEvent> {
  const response = await t.target.fetch(
    `/eve/v1/task-lifecycle/${encodeURIComponent(sessionId)}/next`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, index }),
      signal: t.signal,
    },
  );
  await t.require(response.status, equals(200));
  return (await response.json()) as LifecycleControlEvent;
}

async function releaseGate(
  t: EveEvalContext,
  sessionId: string,
  key: string,
  token: string,
): Promise<void> {
  const response = await t.target.fetch(
    `/eve/v1/task-lifecycle/${encodeURIComponent(sessionId)}/release`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, token }),
      signal: t.signal,
    },
  );
  await t.require(response.status, equals(200));
  await t.require(await response.json(), equals({ released: true }));
}

async function waitForSubagentDispatch(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
): Promise<{
  readonly childSessionId: string;
  readonly session: TaskEvalSessionDriver;
  readonly turns: readonly EveEvalTurn[];
}> {
  let session = initialSession;
  const turns: EveEvalTurn[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sessionId = session.sessionId;
    if (sessionId === undefined)
      throw new Error("Auth snapshot dispatch has no parent session id.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Auth snapshot dispatch wait"),
    });
    const turn = await live.result();
    turn.expectOk();
    turns.push(turn);
    session = live.session;
    const called = turn.events.find(
      (event) => event.type === "subagent.called" && event.data.name === "auth-snapshot-worker",
    );
    if (called?.type === "subagent.called") {
      return { childSessionId: called.data.childSessionId, session, turns };
    }
  }
  throw new Error("The delayed task did not dispatch auth-snapshot-worker.");
}
