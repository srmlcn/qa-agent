import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { QaError } from "../errors/qa-error.js";
import { version } from "../index.js";
import { createLogger } from "../runtime/logger.js";
import { loadTools, type McpTool } from "./load-tools.js";

const SERVER_NAME = "autonomous-qa";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toToolResult(value: unknown): CallToolResult {
  const text = JSON.stringify(value) ?? "null";
  if (isRecord(value)) {
    return {
      content: [{ type: "text", text }],
      structuredContent: value,
    };
  }
  return {
    content: [{ type: "text", text }],
  };
}

function registerLoadedTool(server: McpServer, tool: McpTool): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema,
    },
    async (args) => {
      try {
        const result = await tool.handler(args);
        return toToolResult(result);
      } catch (error) {
        if (error instanceof QaError) {
          const failure: CallToolResult = {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(error.toJSON()) }],
          };
          return failure;
        }
        throw error;
      }
    },
  );
}

/** Loads tools and returns a server that is not yet connected to a transport. */
export async function createMcpServer(): Promise<McpServer> {
  const tools = await loadTools();
  const server = new McpServer({
    name: SERVER_NAME,
    version,
  });

  for (const tool of tools) {
    registerLoadedTool(server, tool);
  }

  return server;
}

function waitForStdinClose(): Promise<void> {
  const stdin = process.stdin;
  if (stdin.readableEnded) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = (): void => {
      stdin.off("end", finish);
      stdin.off("close", finish);
      resolve();
    };
    stdin.on("end", finish);
    stdin.on("close", finish);
  });
}

export async function serveMcp(): Promise<void> {
  const logger = createLogger();
  const server = await createMcpServer();

  const closed = waitForStdinClose();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp server listening on stdio");
  await closed;
  await server.close();
}
