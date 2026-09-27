import { z } from "zod";
import { collectHealth, type HealthReport } from "../../health/status.js";
import type { McpTool } from "../load-tools.js";

export type StatusReport = HealthReport;

const schema = z.object({
  projectRoot: z.string().min(1).optional(),
});

/**
 * Reports runtime health for one project root.
 * The API key value is never read into the report.
 */
export function reportStatus(projectRoot: string): StatusReport {
  return collectHealth(projectRoot);
}

export const tool = {
  name: "qa.status",
  description:
    "Report package, Node, config, browser, home, and LLM health. Does not print secrets or launch a browser.",
  schema,
  async handler(args: unknown): Promise<StatusReport> {
    const input = schema.parse(args);
    return reportStatus(input.projectRoot ?? process.cwd());
  },
} satisfies McpTool;
