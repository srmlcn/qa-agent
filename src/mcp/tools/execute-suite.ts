import { z } from "zod";
import { loadProjectConfig } from "../../config/load-project.js";
import { executeSuite, type SuiteResult } from "../../orchestrator/suite.js";
import type { McpTool } from "../load-tools.js";

const schema = z.object({
  flowIds: z.array(z.string().min(1)).min(1),
  workers: z.number().int().positive().optional(),
  authStrategy: z.enum(["shared", "per-worker"]).optional(),
  projectRoot: z.string().min(1).optional(),
});

export const tool = {
  name: "qa.execute_suite",
  description: "Replay saved flows and return the suite aggregate.",
  schema,
  async handler(args: unknown): Promise<SuiteResult> {
    const input = schema.parse(args);
    const projectRoot = input.projectRoot ?? process.cwd();
    return executeSuite({
      flowIds: input.flowIds,
      authStrategy: input.authStrategy ?? "shared",
      projectRoot,
      config: loadProjectConfig(projectRoot),
      inputs: {},
      ...(input.workers === undefined ? {} : { workers: input.workers }),
    });
  },
} satisfies McpTool;
