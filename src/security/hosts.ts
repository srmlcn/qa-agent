import type { ProjectConfig } from "../config/schema.js";
import { QaError } from "../errors/qa-error.js";

/**
 * Allows `url` only when its host is listed in `config.application.allowedHosts`.
 *
 * Comparison is case-insensitive, ignores one trailing dot, and ignores ports.
 * `http://localhost:3000` matches an allowlist entry of `localhost`.
 *
 * When `application.productionAllowed` is false, a listed host is still rejected
 * unless it is local: the host is `localhost` or ends with `.localhost`, it
 * equals `127.0.0.1`, or it is `[::1]`. A name such as `notlocalhost` does not
 * count. A configured entry such as `staging.example.com` stays blocked until
 * `productionAllowed` is true. This is stricter than the allowlist alone and
 * matches the rule that production execution is disabled by default.
 *
 * This function checks one URL. It does not fetch. Callers must check redirect
 * targets on each hop.
 */
export function assertUrlAllowed(url: string, config: ProjectConfig): void {
  const host = hostFromUrl(url);
  const allowed = new Set(
    config.application.allowedHosts.map((entry) => normalizeHost(entry)),
  );

  if (!allowed.has(host)) {
    throw policyBlocked(`Host ${host} is not in the application allowlist`);
  }

  if (!config.application.productionAllowed && !isLocalDevelopmentHost(host)) {
    throw policyBlocked(
      `Host ${host} is blocked while production execution is disabled`,
    );
  }
}

function hostFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw policyBlocked("URL is not allowed");
  }

  const host = normalizeHost(parsed.hostname);
  if (host.length === 0) {
    throw policyBlocked("URL is not allowed");
  }
  return host;
}

/**
 * Lowercases the host, drops one trailing dot, and drops a numeric port.
 * IPv6 addresses are compared in the bracketed form `URL.hostname` uses.
 */
function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1] !== undefined) {
    return `[${stripOneTrailingDot(bracketed[1])}]`;
  }

  if (value.includes(":")) {
    const portSplit = /^([^:]+):(\d+)$/.exec(value);
    if (portSplit?.[1] !== undefined) {
      value = portSplit[1];
    } else {
      return `[${stripOneTrailingDot(value)}]`;
    }
  }

  return stripOneTrailingDot(value);
}

function stripOneTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function isLocalDevelopmentHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]"
  );
}

function policyBlocked(message: string): QaError {
  return new QaError({
    code: "POLICY_BLOCKED",
    message,
  });
}
