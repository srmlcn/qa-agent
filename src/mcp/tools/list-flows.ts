import { z } from "zod";
import { list, type FlowSummary } from "../../flows/repository.js";
import type { McpTool } from "../load-tools.js";

const schema = z.object({
  projectRoot: z.string().min(1).optional(),
});

export const tool = {
  name: "qa.list_flows",
  description: "List saved flow metadata. Step bodies are not included.",
  schema,
  async handler(args: unknown): Promise<FlowSummary[]> {
    const input = schema.parse(args);
    return list(input.projectRoot ?? process.cwd());
  },
} satisfies McpTool;
