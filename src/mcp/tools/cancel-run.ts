import { z } from "zod";
import { cancel, getRun, type RunRecordStatus } from "../../orchestrator/runs.js";
import type { McpTool } from "../load-tools.js";

const schema = z.object({
  runId: z.string().min(1),
});

export type CancelRunOutput = {
  runId: string;
  status: RunRecordStatus;
};

export const tool = {
  name: "qa.cancel_run",
  description:
    "Cancel a running run and return its status. Finished and already-cancelled runs are left unchanged.",
  schema,
  async handler(args: unknown): Promise<CancelRunOutput> {
    const input = schema.parse(args);
    cancel(input.runId);
    return {
      runId: input.runId,
      status: getRun(input.runId).status,
    };
  },
} satisfies McpTool;
