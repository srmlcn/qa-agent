import { z } from "zod";
import { cancel } from "../../orchestrator/runs.js";
import type { McpTool } from "../load-tools.js";

const schema = z.object({
  runId: z.string().min(1),
});

export type CancelRunOutput = {
  runId: string;
  status: "cancelled";
};

export const tool = {
  name: "qa.cancel_run",
  description: "Cancel a run and return its cancelled status.",
  schema,
  async handler(args: unknown): Promise<CancelRunOutput> {
    const input = schema.parse(args);
    cancel(input.runId);
    return {
      runId: input.runId,
      status: "cancelled",
    };
  },
} satisfies McpTool;
