import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadProjectConfig } from "../config/load-project.js";
import { QA_ERROR_CODES } from "../errors/codes.js";
import { version } from "../index.js";
import { createLogger } from "../runtime/logger.js";
import { loadTools, type McpTool } from "./load-tools.js";
import { debugTools } from "./tools/debug.js";

const SERVER_NAME = "autonomous-qa";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toToolResult(value: unknown): CallToolResult {
  const text = JSON.stringify(value) ?? "null";
  if (isRecord(value)) {
    const result: CallToolResult = {
      content: [{ type: "text", text }],
      structuredContent: value,
    };
    if (isQaErrorResult(value)) {
      result.isError = true;
    }
    return result;
  }
  return {
    content: [{ type: "text", text }],
  };
}

function isQaErrorResult(value: Record<string, unknown>): boolean {
  const code = value.code;
  if (typeof code !== "string" || typeof value.message !== "string") {
    return false;
  }
  return QA_ERROR_CODES.some((candidate) => candidate === code);
}

function registerLoadedTool(server: McpServer, tool: McpTool): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema,
    },
    async (args) => {
      const result = await tool.handler(args);
      return toToolResult(result);
    },
  );
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

export async function createMcpServer(
  projectRoot: string = process.cwd(),
): Promise<McpServer> {
  const tools = await loadTools();
  if (debugToolsEnabled(projectRoot)) {
    tools.push(...debugTools());
    tools.sort(compareToolNames);
  }

  const server = new McpServer({
    name: SERVER_NAME,
    version,
  });
  for (const tool of tools) {
    registerLoadedTool(server, tool);
  }
  return server;
}

function debugToolsEnabled(projectRoot: string): boolean {
  try {
    return loadProjectConfig(projectRoot).stagehand.debugTools;
  } catch {
    // A missing or invalid project config leaves optional debug tools off.
    return false;
  }
}

function compareToolNames(left: McpTool, right: McpTool): number {
  if (left.name < right.name) {
    return -1;
  }
  if (left.name > right.name) {
    return 1;
  }
  return 0;
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
