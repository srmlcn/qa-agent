import { z } from "zod";
import type { McpTool } from "../load-tools.js";

/**
 * Smoke tool for the stdio MCP server.
 * It is not part of the product QA tool set. Later leaves may remove it.
 */
export const tool = {
  name: "qa.ping",
  description: "Smoke tool that reports the MCP server is reachable.",
  schema: z.object({}),
  async handler(): Promise<{ ok: true }> {
    return { ok: true };
  },
} satisfies McpTool;
