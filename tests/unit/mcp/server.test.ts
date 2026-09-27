import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { loadTools } from "../../../src/mcp/load-tools.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const LOG_LINE = "mcp server listening on stdio";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(line: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`stdout is not an MCP frame: ${line}`);
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
    throw new Error(`stdout is not an MCP frame: ${line}`);
  }
  return parsed as JsonRpcMessage;
}

function toolNames(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new Error("tools/list result is missing tools");
  }
  return result.tools.map((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") {
      throw new Error("tools/list entry is missing a name");
    }
    return tool.name;
  });
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

class LineBuffer {
  private pending = "";
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];

  push(chunk: string): void {
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        this.lines.push(line);
      }
      newline = this.pending.indexOf("\n");
    }
  }

  next(timeoutMs: number): Promise<string> {
    const existing = this.lines.shift();
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for an MCP frame"));
      }, timeoutMs);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }
}

test("adding a second tool file lists it without a server switch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-mcp-tools-"));
  const serverSource = await readFile(new URL("../../../src/mcp/server.ts", import.meta.url), "utf8");
  const loaderSource = await readFile(
    new URL("../../../src/mcp/load-tools.ts", import.meta.url),
    "utf8",
  );

  expect(serverSource).not.toContain("qa.ping");
  expect(serverSource).not.toContain("qa.alpha");
  expect(serverSource).not.toContain("qa.beta");
  expect(loaderSource).not.toContain("qa.ping");

  try {
    await writeFile(
      join(directory, "ignore.d.ts"),
      'export const tool = { name: "qa.ignored", description: "skip", schema: {}, async handler() { return {}; } };\n',
    );
    await writeFile(join(directory, "notes.ts"), "export const value = 1;\n");
    await writeFile(
      join(directory, "alpha.ts"),
      [
        'import { z } from "zod";',
        "export const tool = {",
        '  name: "qa.alpha",',
        '  description: "first fixture tool",',
        "  schema: z.object({}),",
        "  async handler() {",
        "    return { alpha: true };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const first = await loadTools(directory);
    expect(first.map((tool) => tool.name)).toEqual(["qa.alpha"]);

    await writeFile(
      join(directory, "beta.ts"),
      [
        'import { z } from "zod";',
        "export const tool = {",
        '  name: "qa.beta",',
        '  description: "second fixture tool",',
        "  schema: z.object({}),",
        "  async handler() {",
        "    return { beta: true };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const second = await loadTools(directory);
    expect(second.map((tool) => tool.name)).toEqual(["qa.alpha", "qa.beta"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "stdio server lists tools, logs on stderr, and exits when stdin closes",
  async () => {
    await execFileAsync("npm", ["run", "build"], { cwd: root });

    const extraTool = join(root, "dist/mcp/tools/second.js");
    await writeFile(
      extraTool,
      [
        'import { z } from "zod";',
        "export const tool = {",
        '  name: "qa.second",',
        '  description: "Second tool loaded from the tools directory.",',
        "  schema: z.object({}),",
        "  async handler() {",
        "    return { second: true };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const child = spawn(process.execPath, [join(root, "dist/cli/main.js"), "mcp"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = new LineBuffer();
    const frames: JsonRpcMessage[] = [];
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const readFrame = async (): Promise<JsonRpcMessage> => {
      const line = await stdout.next(5000);
      const frame = parseFrame(line);
      frames.push(frame);
      return frame;
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for stderr log\n${stderr}`));
        }, 5000);
        const check = (): void => {
          if (stderr.includes(LOG_LINE)) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stderr.on("data", check);
        check();
      });

      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-05",
          capabilities: {},
          clientInfo: { name: "qa-agent-test", version: "0.0.0" },
        },
      });
      const initialized = await readFrame();
      expect(initialized.id).toBe(1);
      expect(isRecord(initialized.result)).toBe(true);
      const serverInfo = isRecord(initialized.result) ? initialized.result.serverInfo : undefined;
      expect(isRecord(serverInfo) && serverInfo.name).toBe("autonomous-qa");

      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listed = await readFrame();
      expect(listed.id).toBe(2);
      expect(toolNames(listed.result).sort()).toEqual([
        "qa.discover_flow",
        "qa.execute_flow",
        "qa.execute_suite",
        "qa.get_run",
        "qa.list_flows",
        "qa.ping",
        "qa.second",
        "qa.status",
      ]);

      send(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "qa.ping", arguments: {} },
      });
      const called = await readFrame();
      expect(called.id).toBe(3);
      expect(isRecord(called.result)).toBe(true);
      if (isRecord(called.result)) {
        expect(called.result.structuredContent).toEqual({ ok: true });
      }

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`mcp server did not exit after stdin closed\n${stderr}`));
        }, 5000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.stdin.end();
      });

      expect(exitCode).toBe(0);
      expect(stderr).toContain(LOG_LINE);
      expect(stderr).toContain(" info ");
      const stdoutText = frames.map((frame) => JSON.stringify(frame)).join("\n");
      expect(stdoutText).not.toContain(LOG_LINE);
      expect(frames.every((frame) => frame.jsonrpc === "2.0")).toBe(true);
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      await rm(extraTool, { force: true });
    }
  },
  30_000,
);
