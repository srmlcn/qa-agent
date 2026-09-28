import { mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  DEFAULT_MAX_RESPONSE_BODY_BYTES,
  DEFAULT_REDACT_HEADERS,
} from "../../config/defaults.js";
import { QaError, type QaErrorJson } from "../../errors/qa-error.js";
import { redactBody, redactCookies, redactHeaders } from "../../security/redaction.js";
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
  const headerNames = session.redactHeaders;
  return {
    events: (session.network ?? []).map((event) => ({
      method: event.method,
      url: redactDebugUrl(event.url, event.headers, headerNames),
      status: event.status,
      headers: flattenHeaders(redactEventHeaders(event.headers, headerNames)),
    })),
  };
}

async function readConsole(): Promise<unknown> {
  const session = requireSession();
  if (isFailure(session)) {
    return session;
  }
  const headerNames = session.redactHeaders;
  return {
    messages: (session.console ?? []).map((event) => {
      const message: { level: string; text: string; url?: string } = {
        level: event.level,
        text: redactDebugText(event.text),
      };
      if (event.url !== undefined) {
        message.url = redactDebugUrl(event.url, undefined, headerNames);
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

const REDACTED = "[redacted]";
const MIN_URL_SECRET_LENGTH = 8;
const SENSITIVE_QUERY_NAMES = [
  "access_token",
  "refresh_token",
  "id_token",
  "apikey",
  "api_key",
  "password",
  "secret",
] as const;

function redactEventHeaders(
  headers: Record<string, string>,
  names: readonly string[] | undefined,
): Record<string, string | string[]> {
  if (names === undefined) {
    return redactHeaders(headers);
  }
  return redactHeaders(headers, names);
}

/**
 * Cookie redaction, then the same body redaction stored evidence applies.
 * Truncation happens after both secret passes.
 */
function redactDebugText(text: string): string {
  return redactBody(redactCookies(text), DEFAULT_MAX_RESPONSE_BODY_BYTES);
}

function redactDebugUrl(
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
  headerNames: readonly string[] | undefined,
): string {
  const names = headerNames ?? DEFAULT_REDACT_HEADERS;
  const scrubbed =
    headers === undefined ? url : scrubHeaderSecrets(url, headers, names);
  return redactDebugText(
    redactNamedQueryValues(redactUserinfoPassword(scrubbed), names),
  );
}

function scrubHeaderSecrets(
  url: string,
  headers: Readonly<Record<string, string>>,
  names: readonly string[],
): string {
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase())) {
      continue;
    }
    for (const secret of secretPieces(value)) {
      secrets.add(secret);
    }
  }
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  let result = url;
  for (const secret of ordered) {
    result = replaceLiteral(result, secret, REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      result = replaceLiteral(result, encoded, REDACTED);
    }
  }
  return result;
}

function secretPieces(value: string): string[] {
  const pieces: string[] = [];
  collectSecret(value, pieces);
  const bearer = /^bearer\s+(\S+)/i.exec(value.trim());
  if (bearer?.[1] !== undefined) {
    collectSecret(bearer[1], pieces);
  }
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    collectSecret(part.slice(separator + 1).trim(), pieces);
  }
  return pieces;
}

function collectSecret(value: string, pieces: string[]): void {
  if (value.length < MIN_URL_SECRET_LENGTH || value === REDACTED) {
    return;
  }
  pieces.push(value);
}

function redactUserinfoPassword(url: string): string {
  return url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/[^/?#@]*:)([^@/?#]+)@/i,
    `$1${REDACTED}@`,
  );
}

function redactNamedQueryValues(url: string, headerNames: readonly string[]): string {
  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex === -1) {
    return url;
  }
  const names = sensitiveQueryNames(headerNames);
  const prefix = beforeHash.slice(0, queryIndex + 1);
  const query = beforeHash
    .slice(queryIndex + 1)
    .split("&")
    .map((pair) => redactQueryPair(pair, names))
    .join("&");
  return `${prefix}${query}${hash}`;
}

function sensitiveQueryNames(headerNames: readonly string[]): Set<string> {
  const names = new Set<string>(SENSITIVE_QUERY_NAMES);
  for (const name of DEFAULT_REDACT_HEADERS) {
    names.add(name.toLowerCase());
  }
  for (const name of headerNames) {
    names.add(name.toLowerCase());
  }
  return names;
}

function redactQueryPair(pair: string, names: ReadonlySet<string>): string {
  const separator = pair.indexOf("=");
  if (separator === -1) {
    return pair;
  }
  const rawKey = pair.slice(0, separator);
  if (!names.has(decodeQueryComponent(rawKey).toLowerCase())) {
    return pair;
  }
  return `${rawKey}=${REDACTED}`;
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

function replaceLiteral(text: string, needle: string, replacement: string): string {
  if (needle.length === 0 || !text.includes(needle)) {
    return text;
  }
  return text.split(needle).join(replacement);
}
