import { z } from "zod";
import { list, type FlowSummary } from "../../flows/repository.js";
import type { McpTool } from "../load-tools.js";

const schema = z.object({});

export const tool = {
  name: "qa.list_flows",
  description: "List saved flow metadata. Step bodies are not included.",
  schema,
  async handler(args: unknown): Promise<FlowSummary[]> {
    schema.parse(args);
    return list(process.cwd());
  },
} satisfies McpTool;
