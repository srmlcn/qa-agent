import type { LlmConfig } from "../config/schema.js";
import { QaError } from "../errors/qa-error.js";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_RETRIES = 2;
const RETRY_STATUSES = new Set([429, 503]);

/**
 * In-process provider. `headers` may contain `Authorization` for this process.
 * Log {@link describeProvider} instead of this object.
 */
export type LlmProvider = {
  provider: LlmConfig["provider"];
  model: string;
  baseUrl: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxRetries: number;
  apiKeyEnv: string;
};

/** Same fields as {@link LlmProvider}, without the API key. */
export type LlmProviderDescription = LlmProvider & {
  apiKeyPresent: boolean;
};

export type ProviderCheckResult =
  | { ok: true }
  | {
      ok: false;
      code: "LLM_PROVIDER_UNAVAILABLE" | "LLM_RATE_LIMITED";
    };

/**
 * Builds a provider description from effective LLM config.
 * An `openai` config with no base URL uses `https://api.openai.com/v1`.
 * An `openai-compatible` config with no base URL throws `LLM_PROVIDER_UNAVAILABLE`.
 * The API key is read from `process.env[apiKeyEnv]` and added only as
 * `Authorization` on the returned headers. A missing or empty environment
 * value removes every Authorization header.
 */
export function createProvider(config: LlmConfig): LlmProvider {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: resolveBaseUrl(config),
    headers: headersWithKey(config.headers, readApiKey(config.apiKeyEnv)),
    timeoutMs: config.timeoutMs,
    maxRetries: DEFAULT_MAX_RETRIES,
    apiKeyEnv: config.apiKeyEnv,
  };
}

/**
 * Returns the provider fields safe to print. Authorization is removed, any
 * copy of the key is stripped, and `apiKeyPresent` reports whether the
 * environment variable is set.
 */
export function describeProvider(provider: LlmProvider): LlmProviderDescription {
  const apiKey = readApiKey(provider.apiKeyEnv);
  const headerKey = bearerToken(provider.headers);
  return {
    provider: provider.provider,
    model: stripSecrets(provider.model, apiKey, headerKey),
    baseUrl: stripSecrets(provider.baseUrl, apiKey, headerKey),
    headers: publicHeaders(provider.headers, apiKey, headerKey),
    timeoutMs: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    apiKeyEnv: provider.apiKeyEnv,
    apiKeyPresent: apiKey !== undefined,
  };
}

/**
 * GET `${baseUrl}/models` using the key from `process.env[apiKeyEnv]`.
 * Times out at `timeoutMs`. Retries HTTP 429 and 503 up to `maxRetries`.
 * Returns `{ ok, code }` and does not include the response body or the key.
 * Pass `fetchImpl` in tests. The default calls global `fetch`.
 */
export async function checkProvider(
  provider: LlmProvider,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProviderCheckResult> {
  const apiKey = readApiKey(provider.apiKeyEnv);
  if (apiKey === undefined) {
    return { ok: false, code: "LLM_PROVIDER_UNAVAILABLE" };
  }

  const headers = headersWithKey(provider.headers, apiKey);
  const url = modelsUrl(provider.baseUrl);
  const attempts = provider.maxRetries + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await requestModels(fetchImpl, url, headers, provider.timeoutMs);
    if (response === undefined) {
      return { ok: false, code: "LLM_PROVIDER_UNAVAILABLE" };
    }

    const status = response.status;
    await discardBody(response);

    if (status >= 200 && status < 300) {
      return { ok: true };
    }

    const retry = RETRY_STATUSES.has(status) && attempt < attempts - 1;
    if (retry) {
      continue;
    }

    return {
      ok: false,
      code: status === 429 ? "LLM_RATE_LIMITED" : "LLM_PROVIDER_UNAVAILABLE",
    };
  }

  return { ok: false, code: "LLM_PROVIDER_UNAVAILABLE" };
}

function resolveBaseUrl(config: LlmConfig): string {
  if (config.baseUrl !== undefined && config.baseUrl.length > 0) {
    return config.baseUrl;
  }
  if (config.provider === "openai") {
    return OPENAI_DEFAULT_BASE_URL;
  }
  throw new QaError({
    code: "LLM_PROVIDER_UNAVAILABLE",
    message: "An openai-compatible provider requires a base URL.",
  });
}

function readApiKey(envName: string): string | undefined {
  const value = process.env[envName];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

function headersWithKey(
  configHeaders: LlmConfig["headers"],
  apiKey: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...(configHeaders ?? {}) };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "authorization") {
      delete headers[name];
    }
  }
  if (apiKey === undefined) {
    return headers;
  }
  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function publicHeaders(
  headers: Readonly<Record<string, string>>,
  apiKey: string | undefined,
  headerKey: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") {
      continue;
    }
    result[name] = stripSecrets(value, apiKey, headerKey);
  }
  return result;
}

function bearerToken(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "authorization") {
      continue;
    }
    if (!value.startsWith("Bearer ")) {
      continue;
    }
    const token = value.slice("Bearer ".length);
    if (token.length > 0) {
      return token;
    }
  }
  return undefined;
}

function stripSecrets(
  value: string,
  apiKey: string | undefined,
  headerKey: string | undefined,
): string {
  return stripSecret(stripSecret(value, apiKey), headerKey);
}

function stripSecret(value: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0 || !value.includes(secret)) {
    return value;
  }
  return value.split(secret).join("");
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

async function requestModels(
  fetchImpl: typeof fetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<Response | undefined> {
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: { ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return undefined;
  }
}

async function discardBody(response: Response): Promise<void> {
  if (response.body === null) {
    return;
  }
  try {
    await response.body.cancel();
  } catch {
    return;
  }
}
