import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import type { LlmConfig } from "../../../src/config/schema.js";
import type { V3Options } from "@browserbasehq/stagehand";
import { QaError } from "../../../src/errors/qa-error.js";
import {
  createStagehand,
  createStagehandClient,
} from "../../../src/stagehand/llm-client.js";
import { createProvider } from "../../../src/stagehand/provider.js";

const API_KEY_ENV = "QA_AGENT_LLM_CLIENT_TEST_KEY";
const API_KEY = "sk-test-qa-agent-llm-client-64";

let previousKey: string | undefined;

beforeEach(() => {
  previousKey = process.env[API_KEY_ENV];
  delete process.env[API_KEY_ENV];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unit test called global fetch");
    }),
  );
});

afterEach(() => {
  if (previousKey === undefined) {
    delete process.env[API_KEY_ENV];
  } else {
    process.env[API_KEY_ENV] = previousKey;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai-compatible",
    model: "company-model",
    baseUrl: "https://llm.example/v1",
    apiKeyEnv: API_KEY_ENV,
    timeoutMs: 1_500,
    headers: { "X-Tenant": "acme" },
    ...overrides,
  };
}

function completionBody(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "company-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    },
  });
}

test("a fake fetch returns one structured step and does not use the network", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig());
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe("https://llm.example/v1/chat/completions");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("x-tenant")).toBe("acme");
    const body = JSON.parse(String(init?.body)) as {
      model?: string;
      response_format?: { type?: string };
    };
    expect(body.model).toBe(provider.model);
    expect(body.response_format).toMatchObject({ type: "json_schema" });
    return new Response(completionBody(JSON.stringify({ step: "archive" })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchImpl);

  const logs: string[] = [];
  const client = createStagehandClient(provider);
  expect(typeof client.getLanguageModel).toBe("function");
  const languageModel = client.getLanguageModel?.();
  expect(languageModel?.modelId).toBe(provider.model);
  expect(languageModel?.provider).toContain("openai");
  const result = await client.createChatCompletion({
    options: {
      messages: [{ role: "user", content: "Archive the project" }],
      response_model: {
        name: "Step",
        schema: z.object({ step: z.string() }),
      },
    },
    logger: (line) => {
      logs.push(JSON.stringify(line));
    },
  });

  expect(result).toMatchObject({
    data: { step: "archive" },
    usage: {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    },
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(logs.join("\n")).not.toContain(API_KEY);
});

test("a named provider does not use the custom chat client", () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(
    llmConfig({
      provider: "openai",
      model: "gpt-5.4",
      baseUrl: undefined,
    }),
  );

  expect(() => createStagehandClient(provider)).toThrow(QaError);
  expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
});

test("openai uses Stagehand's OpenAI client", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(
    llmConfig({
      provider: "openai",
      model: "gpt-5.4",
      baseUrl: "https://gateway.example/v1/",
      headers: { "X-Tenant": "acme" },
    }),
  );
  const stagehand = createStagehand(provider);
  try {
    const opts = stagehandOptions(stagehand);
    expect(opts.llmClient).toBeUndefined();
    expect(opts.experimental).toBe(true);
    expect(opts.disableAPI).toBe(true);
    expect(opts.model).toMatchObject({
      modelName: "openai/gpt-5.4",
      baseURL: "https://gateway.example/v1/",
      headers: { "X-Tenant": "acme" },
    });
    expect(opts.model).not.toHaveProperty("reasoningEffort");
    const client = nativeClient(stagehand);
    expect(client.type).toBe("aisdk");
    expect(client.modelName).toBe("gpt-5.4");
    expect(languageProvider(client)).toContain("openai");
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  } finally {
    await stagehand.close();
  }
});

test("anthropic uses Stagehand's Anthropic client", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(
    llmConfig({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      baseUrl: undefined,
    }),
  );
  const stagehand = createStagehand(provider);
  try {
    const opts = stagehandOptions(stagehand);
    expect(opts.llmClient).toBeUndefined();
    expect(opts.experimental).toBe(true);
    expect(opts.model).toMatchObject({
      modelName: "anthropic/claude-sonnet-4-6",
      baseURL: "https://api.anthropic.com/v1",
    });
    const client = nativeClient(stagehand);
    expect(client.modelName).toBe("claude-sonnet-4-6");
    expect(languageProvider(client)).toContain("anthropic");
  } finally {
    await stagehand.close();
  }
});

test("xai uses Stagehand's xAI client", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(
    llmConfig({
      provider: "xai",
      model: "grok-4",
      baseUrl: undefined,
    }),
  );
  const stagehand = createStagehand(provider);
  try {
    const opts = stagehandOptions(stagehand);
    expect(opts.llmClient).toBeUndefined();
    expect(opts.experimental).toBe(true);
    expect(opts.model).toMatchObject({
      modelName: "xai/grok-4",
      baseURL: "https://api.x.ai/v1",
    });
    const client = nativeClient(stagehand);
    expect(client.modelName).toBe("grok-4");
    expect(languageProvider(client)).toContain("xai");
  } finally {
    await stagehand.close();
  }
});

test("a missing API key throws without the key and does not call fetch", () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig());
  delete process.env[API_KEY_ENV];

  let thrown: unknown;
  try {
    createStagehandClient(provider);
  } catch (error: unknown) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(QaError);
  if (!(thrown instanceof QaError)) {
    return;
  }
  expect(thrown.code).toBe("LLM_PROVIDER_UNAVAILABLE");
  expect(thrown.message).not.toContain(API_KEY);
  expect(JSON.stringify(thrown)).not.toContain(API_KEY);
  expect(String(thrown)).not.toContain(API_KEY);
  expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
});

test("an error response that echoes the API key does not throw the key", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig());
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    return new Response(
      JSON.stringify({ error: { message: `denied ${API_KEY}` } }),
      {
        status: 400,
        statusText: `nope ${API_KEY}`,
        headers: {
          "content-type": "application/json",
          "x-echo": API_KEY,
        },
      },
    );
  });
  vi.stubGlobal("fetch", fetchImpl);

  const client = createStagehandClient(provider);
  let thrown: unknown;
  try {
    await client.createChatCompletion({
      options: {
        messages: [{ role: "user", content: "Archive the project" }],
        response_model: {
          name: "Step",
          schema: z.object({ step: z.string() }),
        },
      },
      logger: () => undefined,
    });
  } catch (error: unknown) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  if (!(thrown instanceof Error)) {
    return;
  }
  expect(thrown.message).not.toContain(API_KEY);
  expect(String(thrown)).not.toContain(API_KEY);
  expect(JSON.stringify(thrown)).not.toContain(API_KEY);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("Stagehand constructor options stay local", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig());
  const stagehand = createStagehand(provider);
  try {
    const opts = stagehandOptions(stagehand);
    expect(opts.env).toBe("LOCAL");
    expect(opts.experimental).toBe(true);
    expect(opts.disableAPI).toBe(true);
    expect(opts.llmClient).toBeDefined();
    expect(typeof opts.llmClient?.getLanguageModel).toBe("function");
    expect(opts.llmClient?.getLanguageModel?.().modelId).toBe(provider.model);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  } finally {
    await stagehand.close();
  }
});

test("stagehand stores a loopback websocket debugger URL", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig());
  const cdpUrl = "ws://127.0.0.1:9222/devtools/browser/test-id";
  const stagehand = createStagehand(provider, cdpUrl);
  try {
    const opts = stagehandOptions(stagehand);
    expect(opts.localBrowserLaunchOptions?.cdpUrl).toBe(cdpUrl);
    expect(opts.experimental).toBe(true);
  } finally {
    await stagehand.close();
  }
});

test("an HTTP debugging base is rejected", () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig());
  let thrown: unknown;
  try {
    createStagehand(provider, "http://127.0.0.1:9222");
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(QaError);
  if (!(thrown instanceof QaError)) {
    return;
  }
  expect(thrown.code).toBe("BROWSER_CRASHED");
  expect(thrown.message).toBe(
    "Stagehand requires a loopback websocket debugger URL.",
  );
  expect(thrown.message).not.toContain(API_KEY);
});

test("no other src file imports Stagehand", () => {
  const srcRoot = fileURLToPath(new URL("../../../src/", import.meta.url));
  const importers = sourceFiles(srcRoot).filter((file) => {
    return readFileSync(file, "utf8").includes("@browserbasehq/stagehand");
  });

  expect(importers.map((file) => relative(srcRoot, file))).toEqual([
    "stagehand/llm-client.ts",
  ]);
});

function stagehandOptions(stagehand: object): {
  env?: string;
  experimental?: boolean;
  disableAPI?: boolean;
  llmClient?: {
    getLanguageModel?: () => { modelId?: string; provider?: string };
  };
  model?: V3Options["model"];
  localBrowserLaunchOptions?: { cdpUrl?: string };
} {
  return (
    stagehand as {
      opts: {
        env?: string;
        experimental?: boolean;
        disableAPI?: boolean;
        llmClient?: {
          getLanguageModel?: () => { modelId?: string; provider?: string };
        };
        model?: V3Options["model"];
        localBrowserLaunchOptions?: { cdpUrl?: string };
      };
    }
  ).opts;
}

function nativeClient(stagehand: object): {
  type?: string;
  modelName?: string;
  getLanguageModel?: () => { provider?: string };
} {
  return (
    stagehand as {
      llmClient?: {
        type?: string;
        modelName?: string;
        getLanguageModel?: () => { provider?: string };
      };
    }
  ).llmClient ?? {};
}

function languageProvider(client: {
  getLanguageModel?: () => { provider?: string };
}): string {
  return client.getLanguageModel?.().provider ?? "";
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}
