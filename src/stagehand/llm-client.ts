import {
  CustomOpenAIClient,
  Stagehand,
  type LLMClient,
  type V3Options,
} from "@browserbasehq/stagehand";
import OpenAI, { type ClientOptions } from "openai";
import type { Browser } from "playwright";
import { QaError } from "../errors/qa-error.js";
import type { LlmProvider } from "./provider.js";

/** Stagehand provider id for each named provider. Grok uses Stagehand's xAI client. */
const STAGEHAND_PROVIDER_PREFIX = {
  openai: "openai",
  anthropic: "anthropic",
  grok: "xai",
} as const;

/**
 * Chat-completions client for `openai-compatible` only.
 * Named providers use Stagehand's client inside {@link createStagehand}.
 * The API key is read from `process.env[provider.apiKeyEnv]`.
 */
export function createStagehandClient(provider: LlmProvider): LLMClient {
  if (provider.provider !== "openai-compatible") {
    throw new QaError({
      code: "LLM_PROVIDER_UNAVAILABLE",
      message: `The ${provider.provider} provider uses Stagehand's client.`,
    });
  }

  const apiKey = requireApiKey(provider);
  const client = new OpenAI({
    apiKey,
    baseURL: provider.baseUrl,
    defaultHeaders: requestHeaders(provider.headers, apiKey),
    timeout: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    fetch: guardedFetch(apiKey),
  });
  return new CustomOpenAIClient({
    modelName: provider.model,
    client,
  });
}

/** Throws `LLM_PROVIDER_UNAVAILABLE` when the provider API key is missing. */
export function requireApiKey(provider: LlmProvider): string {
  const apiKey = readApiKey(provider.apiKeyEnv);
  if (apiKey === undefined) {
    throw new QaError({
      code: "LLM_PROVIDER_UNAVAILABLE",
      message: "The model provider API key is not set.",
    });
  }
  return apiKey;
}

/**
 * Local Stagehand instance for `provider`.
 *
 * Stagehand v3 has no constructor field for an existing Playwright page. It
 * can attach a browser only through `localBrowserLaunchOptions.cdpUrl`, and
 * the installed Playwright `Browser` does not expose that URL. This function
 * does not call `init()`, so it does not launch a separate local Chromium.
 * `close()` still stops that Chromium if a later `init()` launched one.
 */
export function createStagehand(
  provider: LlmProvider,
  browser: Browser,
): Stagehand {
  const options: V3Options = {
    env: "LOCAL",
    disablePino: true,
    verbose: 0,
    disableAPI: true,
    logger: () => undefined,
    ...stagehandModelOptions(provider),
  };
  const endpoint = browserCdpUrl(browser);
  if (endpoint !== undefined) {
    options.localBrowserLaunchOptions = { cdpUrl: endpoint };
  }
  return new Stagehand(options);
}

function stagehandModelOptions(
  provider: LlmProvider,
): Pick<V3Options, "llmClient" | "model"> {
  if (provider.provider === "openai-compatible") {
    return {
      llmClient: createStagehandClient(provider),
      model: provider.model,
    };
  }

  const apiKey = requireApiKey(provider);
  const prefix = STAGEHAND_PROVIDER_PREFIX[provider.provider];
  const modelName = provider.model.startsWith(`${prefix}/`)
    ? provider.model
    : `${prefix}/${provider.model}`;
  return {
    model: {
      modelName,
      apiKey,
      baseURL: provider.baseUrl,
      headers: stagehandHeaders(provider.headers),
      ...(provider.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: provider.reasoningEffort }),
    },
  };
}

function stagehandHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key") {
      continue;
    }
    result[name] = value;
  }
  return result;
}

function browserCdpUrl(browser: Browser): string | undefined {
  if (!("cdpUrl" in browser)) {
    return undefined;
  }
  const value = browser.cdpUrl;
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

function readApiKey(envName: string): string | undefined {
  const value = process.env[envName];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

function requestHeaders(
  providerHeaders: Readonly<Record<string, string>>,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(providerHeaders)) {
    if (name.toLowerCase() === "authorization") {
      continue;
    }
    headers[name] = value;
  }
  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function guardedFetch(apiKey: string): NonNullable<ClientOptions["fetch"]> {
  const fetchImpl: NonNullable<ClientOptions["fetch"]> = async (url, init) => {
    let response: Response;
    try {
      response = await globalThis.fetch(
        url as Parameters<typeof fetch>[0],
        init as Parameters<typeof fetch>[1],
      );
    } catch (error) {
      throw redactError(error, apiKey);
    }
    if (response.ok) {
      return response as unknown as Awaited<
        ReturnType<NonNullable<ClientOptions["fetch"]>>
      >;
    }
    const body = stripSecret(await response.text(), apiKey);
    return new Response(body, {
      status: response.status,
      statusText: stripSecret(response.statusText, apiKey),
      headers: redactHeaders(response.headers, apiKey),
    }) as unknown as Awaited<ReturnType<NonNullable<ClientOptions["fetch"]>>>;
  };
  return fetchImpl;
}

function redactHeaders(headers: Headers, secret: string): Headers {
  const cleaned = new Headers();
  headers.forEach((value, name) => {
    cleaned.set(name, stripSecret(value, secret));
  });
  return cleaned;
}

function redactError(error: unknown, secret: string | undefined): Error {
  const message =
    error instanceof Error ? error.message : "The model request failed.";
  const stripped = stripSecret(message, secret);
  const cleaned = new Error(
    stripped.length > 0 ? stripped : "The model request failed.",
  );
  if (error instanceof Error && error.name.length > 0) {
    cleaned.name = stripSecret(error.name, secret);
  }
  return cleaned;
}

function stripSecret(value: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0 || !value.includes(secret)) {
    return value;
  }
  return value.split(secret).join("");
}
