import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Report the task dispatch principal through snapshot_whoami.",
  model: mockModel({
    modelId: "task-auth-snapshot-worker",
    respond: ({ messages }) => {
      const result = [...messages].reverse().find((message) => message.role === "tool");
      return result === undefined
        ? { toolCalls: [{ id: "snapshot-whoami", name: "snapshot_whoami", input: {} }] }
        : result.text;
    },
  }),
  modelContextWindowTokens: 1_000_000,
});
