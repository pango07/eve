import type { EveEvalContext } from "eve/evals";
import { equals } from "eve/evals/expect";

import type { LifecycleControlEvent } from "../agent/lib/lifecycle-control.js";
import { requireSessionStreamIndex, type TaskEvalSessionDriver } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const ALICE_AUTHORIZATION = "Bearer e2e-task-operation-a";
const BOB_AUTHORIZATION = "Bearer e2e-task-operation-b";

export default defineTaskEval({
  description:
    "A background task keeps its creator's authentication after a later turn changes the current caller.",
  transition: {
    primary: "task.dispatch.start.accepted-acknowledged",
    dimensions: { transport: "local" },
  },
  async test(t) {
    // Alice creates the session, so the session initiator is Alice.
    const firstTurn = await t.send("TASK-AUTH-SNAPSHOT-ROOT", {
      headers: { authorization: ALICE_AUTHORIZATION },
    });
    firstTurn.expectOk();
    firstTurn.messageIncludes("TASK-AUTH-SNAPSHOT-ROOT-ACK");

    // Bob creates the task. Its current caller is Bob and its initiator is Alice.
    const key = crypto.randomUUID();
    const started = await t.send(`TASK-AUTH-SNAPSHOT ${key}`, {
      headers: { authorization: BOB_AUTHORIZATION },
    });
    started.expectOk();
    started.messageIncludes("TASK-AUTH-SNAPSHOT-STARTED");
    const sessionId = started.sessionId;
    if (sessionId === undefined) throw new Error("The task has no parent session.");

    const gateToken = await waitForGate(t, sessionId, key);

    // Alice takes the last parent turn before the task starts its subagent.
    const lastParentTurn = await t.send("TASK-AUTH-SNAPSHOT-LATER", {
      headers: { authorization: ALICE_AUTHORIZATION },
    });
    lastParentTurn.expectOk();
    lastParentTurn.messageIncludes("TASK-AUTH-SNAPSHOT-LATER-ACK");
    lastParentTurn.usedNoTools();

    await releaseGate(t, sessionId, key, gateToken);
    const childSessionId = await waitForSubagent(t, t);
    const child = await t.target.watchTurn(childSessionId).result();
    child.expectOk();
    child.noFailedActions();
    child.calledTool("snapshot_whoami", { count: 1, status: "completed" });
    await t.require(
      child.requireToolCall("snapshot_whoami").output,
      equals({ current: "operation-user-b", initiator: "operation-user-a" }),
    );
  },
});

async function waitForGate(t: EveEvalContext, sessionId: string, key: string): Promise<string> {
  for (let index = 0; index < 2; index += 1) {
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
    const event = (await response.json()) as LifecycleControlEvent;
    if (event.kind === "gate" && event.token !== undefined) return event.token;
  }
  throw new Error("The background task did not pause before starting its subagent.");
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

async function waitForSubagent(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
): Promise<string> {
  let session = initialSession;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("The task has no parent session.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Subagent wait"),
    });
    const turn = await live.result();
    turn.expectOk();
    session = live.session;
    const called = turn.events.find(
      (event) => event.type === "subagent.called" && event.data.name === "auth-snapshot-worker",
    );
    if (called?.type === "subagent.called") return called.data.childSessionId;
  }
  throw new Error("The background task did not start its subagent.");
}
