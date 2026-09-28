import { mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { redactSavedTrace } from "../../evidence/traces.js";
import { QaError, type QaErrorJson } from "../../errors/qa-error.js";
import { redactCookies, redactHeaders } from "../../security/redaction.js";
import type { McpTool } from "../load-tools.js";

const SCREENSHOT_FILE = "screenshot.png";
const TRACE_FILE = "trace.zip";

/**
 * Empty on purpose. A caller cannot pass a shell command or a filesystem path.
 * Screenshot and trace files are written only under the active run directory.
 */
const noArgs = z.object({}).strict();

export type DebugPage = {
  url(): string;
  title(): Promise<string>;
  screenshot(options: { path: string; type: "png" }): Promise<void>;
};

export type DebugBrowserContext = {
  tracing: {
    stop(options?: { path?: string }): Promise<void>;
  };
};

export type DebugNetworkEvent = {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
};

export type DebugConsoleEvent = {
  level: string;
  text: string;
  url?: string;
};

/** Runtime binding for the optional debug tools. Not an MCP argument. */
export type DebugSession = {
  page: DebugPage;
  artifactDir: string;
  context: DebugBrowserContext;
  network?: readonly DebugNetworkEvent[];
  console?: readonly DebugConsoleEvent[];
  /**
   * Active project `security.redactHeaders`.
   * When omitted, header redaction keeps the default name list.
   */
  redactHeaders?: readonly string[];
};

let activeSession: DebugSession | undefined;

export function setDebugSession(session: DebugSession | undefined): void {
  activeSession = session;
}

/**
 * Optional browser debug tools.
 * This module does not export `tool`, so the autoloader leaves them unregistered
 * until the server opts in with `stagehand.debugTools`.
 */
export function debugTools(): McpTool[] {
  return [
    {
      name: "browser.screenshot",
      description:
        "Save a PNG of the active page into the active run artifact directory.",
      schema: noArgs,
      handler: takeScreenshot,
    },
    {
      name: "browser.network",
      description: "Return redacted network records for the active page.",
      schema: noArgs,
      handler: readNetwork,
    },
    {
      name: "browser.console",
      description: "Return console messages for the active page.",
      schema: noArgs,
      handler: readConsole,
    },
    {
      name: "browser.trace",
      description:
        "Save the active browser trace into the active run artifact directory.",
      schema: noArgs,
      handler: saveTrace,
    },
    {
      name: "browser.inspect",
      description: "Return the active page URL and title.",
      schema: noArgs,
      handler: inspectPage,
    },
  ];
}

async function takeScreenshot(): Promise<unknown> {
  const session = requireSession();
  if (isFailure(session)) {
    return session;
  }
  const filePath = artifactFile(session.artifactDir, SCREENSHOT_FILE);
  mkdirSync(session.artifactDir, { recursive: true });
  await session.page.screenshot({ path: filePath, type: "png" });
  return { screenshot: SCREENSHOT_FILE };
}

async function readNetwork(): Promise<unknown> {
  const session = requireSession();
  if (isFailure(session)) {
    return session;
  }
  return {
    events: (session.network ?? []).map((event) => ({
      method: event.method,
      url: event.url,
      status: event.status,
      headers: flattenHeaders(redactHeaders(event.headers)),
    })),
  };
}

async function readConsole(): Promise<unknown> {
  const session = requireSession();
  if (isFailure(session)) {
    return session;
  }
  return {
    messages: (session.console ?? []).map((event) => {
      const message: { level: string; text: string; url?: string } = {
        level: event.level,
        text: redactCookies(event.text),
      };
      if (event.url !== undefined) {
        message.url = redactCookies(event.url);
      }
      return message;
    }),
  };
}

async function saveTrace(): Promise<unknown> {
  const session = requireSession();
  if (isFailure(session)) {
    return session;
  }
  const filePath = artifactFile(session.artifactDir, TRACE_FILE);
  mkdirSync(session.artifactDir, { recursive: true });
  await session.context.tracing.stop({ path: filePath });
  redactSavedTrace(filePath, session.redactHeaders);
  return { trace: TRACE_FILE };
}

async function inspectPage(): Promise<unknown> {
  const session = requireSession();
  if (isFailure(session)) {
    return session;
  }
  return {
    url: session.page.url(),
    title: await session.page.title(),
  };
}

function requireSession(): DebugSession | QaErrorJson {
  if (activeSession === undefined) {
    return new QaError({
      code: "FLOW_VALIDATION_FAILED",
      message: "no active page",
    }).toJSON();
  }
  return activeSession;
}

function isFailure(value: DebugSession | QaErrorJson): value is QaErrorJson {
  return "code" in value;
}

function artifactFile(artifactDir: string, name: string): string {
  const root = resolve(artifactDir);
  const filePath = join(root, name);
  if (relative(root, filePath) !== name) {
    throw new QaError({
      code: "FLOW_VALIDATION_FAILED",
      message: "no active page",
    });
  }
  return filePath;
}

function flattenHeaders(
  headers: Record<string, string | readonly string[]>,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    flat[name] = typeof value === "string" ? value : value.join("\n");
  }
  return flat;
}
