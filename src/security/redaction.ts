import { Buffer } from "node:buffer";

const REDACTED = "[redacted]";
const TRUNCATED_SUFFIX = "\n[truncated]";

const DEFAULT_REDACT_HEADER_NAMES = Object.freeze([
  "authorization",
  "cookie",
  "set-cookie",
]);

const SENSITIVE_JSON_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "apiKey",
  "api_key",
  "password",
  "secret",
]);

const COOKIE_ATTRIBUTE_NAMES = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "samesite",
  "secure",
  "httponly",
  "partitioned",
  "priority",
]);

export type HeaderValue = string | readonly string[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStorageState(value: unknown): value is { cookies: unknown[] } {
  return isPlainObject(value) && Array.isArray(value.cookies);
}

function redactHeaderValue(value: HeaderValue): string | string[] {
  if (Array.isArray(value)) {
    return value.map(() => REDACTED);
  }
  return REDACTED;
}

export function redactHeaders(
  headers: Readonly<Record<string, HeaderValue>>,
  names: readonly string[] = DEFAULT_REDACT_HEADER_NAMES,
): Record<string, string | string[]> {
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  const result: Record<string, string | string[]> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (blocked.has(name.toLowerCase())) {
      result[name] = redactHeaderValue(value);
    } else if (typeof value === "string") {
      result[name] = value;
    } else {
      result[name] = [...value];
    }
  }

  return result;
}

function redactCookiePairList(
  cookieList: string,
  preserveAttributes: boolean,
): string {
  let seenNameValue = false;
  return cookieList
    .split(";")
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator === -1) {
        return part;
      }
      const rawName = part.slice(0, separator);
      const isFirstNameValue = !seenNameValue;
      seenNameValue = true;
      if (
        preserveAttributes &&
        !isFirstNameValue &&
        COOKIE_ATTRIBUTE_NAMES.has(rawName.trim().toLowerCase())
      ) {
        return part;
      }
      return `${rawName}=${REDACTED}`;
    })
    .join(";");
}

function redactCookieHeaders(text: string): string {
  return text.replace(
    /^([ \t]*)((?:set-)?cookie)([ \t]*:[ \t]*)(.*)$/gim,
    (
      _match,
      indent: string,
      name: string,
      separator: string,
      value: string,
    ) =>
      `${indent}${name}${separator}${redactCookiePairList(
        value,
        name.toLowerCase() === "set-cookie",
      )}`,
  );
}

function redactDocumentCookieAssignments(text: string): string {
  return text.replace(
    /document\.cookie[ \t]*=[ \t]*(["'])([\s\S]*?)\1/gi,
    (match, quote: string, value: string) => {
      const prefix = match.slice(0, match.indexOf(quote));
      return `${prefix}${quote}${redactCookiePairList(value, true)}${quote}`;
    },
  );
}

function looksLikeCookiePairList(text: string): boolean {
  const trimmed = text.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("\n") ||
    trimmed.includes("{") ||
    trimmed.includes('"') ||
    trimmed.includes("'")
  ) {
    return false;
  }

  const parts = trimmed.split(";");
  const meaningful = parts.filter((part, index) => {
    return part.trim().length > 0 || index !== parts.length - 1;
  });
  if (meaningful.length === 0 || !meaningful.some((part) => part.includes("="))) {
    return false;
  }

  return meaningful.every((part) => {
    const piece = part.trim();
    if (piece.length === 0) {
      return false;
    }
    const separator = piece.indexOf("=");
    if (separator === -1) {
      return /^[A-Za-z][\w-]*$/.test(piece);
    }
    const name = piece.slice(0, separator).trim();
    return name.length > 0 && !/[\s:]/.test(name);
  });
}

function redactSensitiveJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveJsonValue(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_JSON_KEYS.has(key)
      ? REDACTED
      : redactSensitiveJsonValue(child);
  }
  return result;
}

function redactJsonKeysLiteral(text: string): string {
  return text.replace(
    /"(access_token|refresh_token|id_token|apiKey|api_key|password|secret)"(\s*:\s*)(?:"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    `"$1"$2"${REDACTED}"`,
  );
}

function redactJsonKeys(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(redactSensitiveJsonValue(parsed));
    }
  } catch {
    // The captured body is not a single JSON value.
  }
  return redactJsonKeysLiteral(text);
}

function redactStorageState(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isStorageState(parsed)) {
    return undefined;
  }

  const redacted = redactSensitiveJsonValue(parsed);
  if (!isStorageState(redacted)) {
    return undefined;
  }

  redacted.cookies = redacted.cookies.map((cookie) => {
    if (!isPlainObject(cookie) || !("value" in cookie)) {
      return cookie;
    }
    return { ...cookie, value: REDACTED };
  });

  return JSON.stringify(redacted);
}

export function redactCookies(text: string): string {
  const storageState = redactStorageState(text);
  if (storageState !== undefined) {
    return storageState;
  }

  const withAssignments = redactCookieHeaders(
    redactDocumentCookieAssignments(text),
  );
  if (looksLikeCookiePairList(withAssignments)) {
    return redactCookiePairList(withAssignments, false);
  }
  return withAssignments;
}

function redactAuthorizationHeaders(text: string): string {
  return text.replace(
    /(^|[^\w-])(authorization)([ \t]*:[ \t]*)[^\r\n]*/gi,
    (_match, prefix: string, name: string, separator: string) =>
      `${prefix}${name}${separator}${REDACTED}`,
  );
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes)) {
    return text;
  }
  const limit = Math.max(0, Math.trunc(maxBytes));
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) {
    return text;
  }

  let end = limit;
  while (end > 0) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    end -= 1;
  }

  return `${bytes.subarray(0, end).toString("utf8")}${TRUNCATED_SUFFIX}`;
}

export function redactBody(text: string, maxBytes: number): string {
  const redacted = redactJsonKeys(redactAuthorizationHeaders(text));
  return truncateToBytes(redacted, maxBytes);
}
