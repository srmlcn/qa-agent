import { z } from "zod";
import { loadProjectConfig } from "../../config/load-project.js";
import { QaError } from "../../errors/qa-error.js";
import type { FlowSpec } from "../../flows/schema.js";
import { repairFlow } from "../../orchestrator/repair.js";
import { createProvider } from "../../stagehand/provider.js";
import type { McpTool } from "../load-tools.js";

const schema = z.object({
  flowId: z.string().min(1),
  failedStepId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
});

export type RepairFlowOutput = {
  repaired: boolean;
  runId: string;
  flow?: FlowSpec;
};

/**
 * Repairs a stale flow. The public schema requires only `flowId`.
 * A missing failed step or run id is `run not found` and does not call repair.
 * Cookies, the failure reason, and the repair run id are not returned.
 */
export const tool = {
  name: "qa.repair_flow",
  description:
    "Repair a stale flow and return the original run id, plus the flow when repair succeeds.",
  schema,
  async handler(args: unknown): Promise<RepairFlowOutput> {
    const input = schema.parse(args);
    const projectRoot = process.cwd();
    const config = loadProjectConfig(projectRoot);
    const provider = createProvider(config.llm);
    if (input.failedStepId === undefined || input.runId === undefined) {
      throw new QaError({
        code: "FLOW_VALIDATION_FAILED",
        message: "run not found",
      });
    }
    const repaired = await repairFlow({
      flowId: input.flowId,
      failedStepId: input.failedStepId,
      runId: input.runId,
      projectRoot,
      config,
      provider,
    });
    if (!repaired.repaired) {
      return {
        repaired: false,
        runId: repaired.runId,
      };
    }
    return {
      repaired: true,
      runId: repaired.runId,
      flow: repaired.flow,
    };
  },
} satisfies McpTool;
