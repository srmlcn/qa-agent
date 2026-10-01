import { createOpenAI } from "@ai-sdk/openai";
import {
  AISdkClient,
  Stagehand,
  type LLMClient,
  type V3Options,
} from "@browserbasehq/stagehand";
import { QaError } from "../errors/qa-error.js";
import type { LlmProvider } from "./provider.js";

type StagehandLanguageModel = ConstructorParameters<typeof AISdkClient>[0]["model"];

/**
 * OpenAI-compatible client for Stagehand v3.
 * Named providers use Stagehand's client inside {@link createStagehand}.
 * The API key is read from `process.env[provider.apiKeyEnv]`.
 *
 * `V3AgentHandler.prepareAgent` calls `getLanguageModel()`. The chat-completions
 * client Stagehand exports for custom OpenAI endpoints does not implement that
 * method, so this returns an {@link AISdkClient} that does.
 */
export function createStagehandClient(provider: LlmProvider): LLMClient {
  if (provider.provider !== "openai-compatible") {
    throw new QaError({
      code: "LLM_PROVIDER_UNAVAILABLE",
      message: `The ${provider.provider} provider uses Stagehand's client.`,
    });
  }

  const apiKey = requireApiKey(provider);
  const model = createOpenAI({
    apiKey,
    baseURL: provider.baseUrl,
    headers: requestHeaders(provider.headers, apiKey),
    fetch: guardedFetch(apiKey, provider.timeoutMs),
  }).chat(provider.model);
  return new AgentLanguageClient(model);
}

/**
 * Public {@link AISdkClient} stores the model privately and does not expose it.
 * The v3 agent reads it through `getLanguageModel()`.
 */
class AgentLanguageClient extends AISdkClient {
  private readonly languageModel: StagehandLanguageModel;

  constructor(languageModel: StagehandLanguageModel) {
    super({ model: languageModel });
    this.languageModel = languageModel;
  }

  getLanguageModel(): StagehandLanguageModel {
    return this.languageModel;
  }
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
 * Discovery always forwards an AbortSignal to `agent.execute`. Installed
 * Stagehand 3.x treats that signal as experimental, so every instance sets
 * `experimental` together with `disableAPI`.
 *
 * `cdpUrl` is Chromium's `webSocketDebuggerUrl`. An HTTP debugging base makes
 * the websocket handshake fail with `Unexpected server response: 404`.
 * This function does not call `init()`.
 */
export function createStagehand(
  provider: LlmProvider,
  cdpUrl?: string,
): Stagehand {
  const endpoint = cdpUrl === undefined ? undefined : websocketDebuggerUrl(cdpUrl);
  const options: V3Options = {
    env: "LOCAL",
    disablePino: true,
    verbose: 0,
    disableAPI: true,
    experimental: true,
    logger: () => undefined,
    ...stagehandModelOptions(provider),
  };
  if (endpoint !== undefined) {
    options.localBrowserLaunchOptions = { cdpUrl: endpoint };
  }
  return new Stagehand(options);
}

function websocketDebuggerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidDebuggerUrl();
  }
  const websocket = parsed.protocol === "ws:" || parsed.protocol === "wss:";
  if (!websocket || !isLoopbackHost(parsed.hostname)) {
    throw invalidDebuggerUrl();
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function invalidDebuggerUrl(): QaError {
  return new QaError({
    code: "BROWSER_CRASHED",
    message: "Stagehand requires a loopback websocket debugger URL.",
  });
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
  const prefix = provider.provider;
  const modelName = provider.model.startsWith(`${prefix}/`)
    ? provider.model
    : `${prefix}/${provider.model}`;
  return {
    model: {
      modelName,
      apiKey,
      baseURL: provider.baseUrl,
      headers: stagehandHeaders(provider.headers),
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

function guardedFetch(apiKey: string, timeoutMs: number): typeof fetch {
  const fetchImpl: typeof fetch = async (url, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      init?.signal === undefined || init.signal === null
        ? timeout
        : AbortSignal.any([init.signal, timeout]);
    let response: Response;
    try {
      response = await globalThis.fetch(url, { ...init, signal });
    } catch (error) {
      throw redactError(error, apiKey);
    }
    if (response.ok) {
      return response;
    }
    const body = stripSecret(await response.text(), apiKey);
    return new Response(body, {
      status: response.status,
      statusText: stripSecret(response.statusText, apiKey),
      headers: redactHeaders(response.headers, apiKey),
    });
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
