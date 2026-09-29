import { serveMcp } from "../../mcp/server.js";
import type { Command } from "../types.js";

export const command: Command = {
  name: "mcp",
  summary: "serve MCP tools over stdio",
  async run(): Promise<number> {
    await serveMcp();
    return 0;
  },
};
