import { z } from "zod";
import { loadProjectConfig } from "../../config/load-project.js";
import type { RunResult } from "../../evidence/types.js";
import { executeFlow } from "../../orchestrator/execution.js";
import type { McpTool } from "../load-tools.js";

const flowInputValue = z.union([z.string(), z.number(), z.boolean()]);

const schema = z.object({
  flowId: z.string().min(1),
  inputs: z.record(flowInputValue).optional().default({}),
  authProfile: z.string().min(1).optional(),
  headed: z.boolean().optional().default(false),
  collectTrace: z.boolean().optional(),
});

export type ExecuteFlowToolResult = {
  runId: string;
  status: RunResult["status"];
  failure?: NonNullable<RunResult["failure"]>;
};

export const tool = {
  name: "qa.execute_flow",
  description:
    "Replay one saved flow with Playwright and return the run id and status.",
  schema,
  async handler(args: unknown): Promise<ExecuteFlowToolResult> {
    const input = schema.parse(args);
    const projectRoot = process.cwd();
    const executed = await executeFlow({
      flowId: input.flowId,
      inputs: input.inputs,
      projectRoot,
      config: loadProjectConfig(projectRoot),
      headed: input.headed,
      ...(input.authProfile === undefined
        ? {}
        : { authProfile: input.authProfile }),
      ...(input.collectTrace === undefined
        ? {}
        : { collectTrace: input.collectTrace }),
    });
    const output: ExecuteFlowToolResult = {
      runId: executed.runId,
      status: executed.result.status,
    };
    if (executed.result.failure !== undefined) {
      output.failure = executed.result.failure;
    }
    return output;
  },
} satisfies McpTool;
