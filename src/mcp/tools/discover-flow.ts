import { z } from "zod";
import type { RunStatus } from "../../evidence/types.js";
import type { FlowSpec } from "../../flows/schema.js";
import { discoverFlow } from "../../orchestrator/discovery.js";
import { createProvider } from "../../stagehand/provider.js";
import type { McpTool } from "../load-tools.js";
import { loadToolConfig } from "../project-root.js";

const schema = z.object({
  objective: z.string().min(1),
  startUrl: z.string().min(1).optional(),
  authProfile: z.string().min(1).optional(),
  constraints: z.array(z.string().min(1)).optional(),
  maxSteps: z.number().int().positive().optional(),
  projectRoot: z.string().min(1).optional(),
});

export type DiscoverFlowOutput = {
  runId: string;
  flow: FlowSpec;
  status: RunStatus;
};

/**
 * Asks the discovery pipeline for a validated flow.
 * The handler does not explore the UI. Storage state, cookies, and the API key
 * are not part of the returned object.
 */
export const tool = {
  name: "qa.discover_flow",
  description:
    "Discover a flow for an objective and return the validated FlowSpec and run id. Does not explore the UI in this handler.",
  schema,
  async handler(args: unknown): Promise<DiscoverFlowOutput> {
    const input = schema.parse(args);
    const { projectRoot, config } = await loadToolConfig(input.projectRoot);
    const provider = createProvider(config.llm);
    const discovered = await discoverFlow({
      id: flowIdFromObjective(input.objective),
      name: input.objective,
      objective: objectiveWithConstraints(input.objective, input.constraints),
      projectRoot,
      config,
      provider,
      ...(input.startUrl === undefined ? {} : { startUrl: input.startUrl }),
      ...(input.authProfile === undefined ? {} : { authProfile: input.authProfile }),
      ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    });
    return {
      runId: discovered.runId,
      flow: discovered.flow,
      status: discovered.result.status,
    };
  },
} satisfies McpTool;

/**
 * Flow ids are `discovered.<slug>`. The first segment cannot contain hyphens.
 */
function flowIdFromObjective(objective: string): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (slug.length === 0) {
    return "discovered.flow";
  }
  return `discovered.${slug}`;
}

function objectiveWithConstraints(
  objective: string,
  constraints: readonly string[] | undefined,
): string {
  if (constraints === undefined || constraints.length === 0) {
    return objective;
  }
  return [objective, ...constraints].join("\n");
}
