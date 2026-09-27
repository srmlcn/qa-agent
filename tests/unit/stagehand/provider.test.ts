import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LlmConfig } from "../../../src/config/schema.js";
import { QaError } from "../../../src/errors/qa-error.js";
import {
  checkProvider,
  createProvider,
  describeProvider,
} from "../../../src/stagehand/provider.js";

const API_KEY_ENV = "QA_AGENT_TEST_LLM_KEY";
const API_KEY = "sk-test-qa-agent-llm-64";

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
    ...overrides,
  };
}

test("openai defaults the base URL and retry count", () => {
  const provider = createProvider(
    llmConfig({
      provider: "openai",
      model: "configured-model",
      baseUrl: undefined,
    }),
  );

  expect(provider).toMatchObject({
    provider: "openai",
    model: "configured-model",
    baseUrl: "https://api.openai.com/v1",
    timeoutMs: 1_500,
    maxRetries: 2,
    apiKeyEnv: API_KEY_ENV,
  });
  expect(provider.headers.Authorization).toBeUndefined();
});

test("openai keeps an explicit base URL", () => {
  const provider = createProvider(
    llmConfig({
      provider: "openai",
      baseUrl: "https://gateway.example/v1/",
    }),
  );

  expect(provider.baseUrl).toBe("https://gateway.example/v1/");
});

test("openai-compatible without a base URL throws LLM_PROVIDER_UNAVAILABLE", () => {
  process.env[API_KEY_ENV] = API_KEY;
  let thrown: unknown;
  try {
    createProvider(
      llmConfig({
        baseUrl: undefined,
      }),
    );
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
});

test("headers copy config headers and add the bearer token in process", () => {
  process.env[API_KEY_ENV] = API_KEY;
  const headers = { "X-Tenant": "acme", authorization: "stale" };
  const config = llmConfig({ headers });
  const provider = createProvider(config);

  expect(headers).toEqual({ "X-Tenant": "acme", authorization: "stale" });
  expect(provider.headers).toEqual({
    "X-Tenant": "acme",
    Authorization: `Bearer ${API_KEY}`,
  });
  expect(provider.headers).not.toBe(headers);
});

test("describeProvider JSON omits the key and reports apiKeyPresent", () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(
    llmConfig({
      headers: { "X-Echo": `prefix-${API_KEY}-suffix`, "X-Tenant": "acme" },
    }),
  );
  const description = describeProvider(provider);

  expect(description.apiKeyPresent).toBe(true);
  expect(description.headers.Authorization).toBeUndefined();
  expect(description.headers["X-Tenant"]).toBe("acme");
  expect(description.headers["X-Echo"]).toBe("prefix--suffix");
  expect(description.maxRetries).toBe(2);
  expect(JSON.stringify(description)).not.toContain(API_KEY);
});

test("a missing API key is unavailable and does not call fetch", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const provider = createProvider(llmConfig());
  const description = describeProvider(provider);
  const result = await checkProvider(provider, fetchImpl);

  expect(result).toEqual({ ok: false, code: "LLM_PROVIDER_UNAVAILABLE" });
  expect(description.apiKeyPresent).toBe(false);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(API_KEY);
  expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
});

test("an injected 429 becomes LLM_RATE_LIMITED without the body", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig());
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    return new Response(`rate-limit-body-${API_KEY}`, { status: 429 });
  });

  const result = await checkProvider(provider, fetchImpl);

  expect(result).toEqual({ ok: false, code: "LLM_RATE_LIMITED" });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(result)).not.toContain(API_KEY);
  expect(JSON.stringify(result)).not.toContain("rate-limit-body");
  expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
});

test("429 and 503 are retried until a successful models response", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(
    llmConfig({
      timeoutMs: 40,
      headers: { "X-Tenant": "acme" },
    }),
  );
  const statuses = [429, 503, 200];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe("https://llm.example/v1/models");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("x-tenant")).toBe("acme");
    const status = statuses.shift() ?? 500;
    return new Response(`body-${API_KEY}`, { status });
  });

  const result = await checkProvider(
    provider,
    fetchImpl,
  );

  expect(result).toEqual({ ok: true });
  expect(statuses).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(API_KEY);
});

test("a trailing slash is not doubled on the models URL", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(
    llmConfig({ baseUrl: "https://llm.example/v1/" }),
  );
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    expect(String(input)).toBe("https://llm.example/v1/models");
    return new Response(null, { status: 204 });
  });

  await expect(checkProvider(provider, fetchImpl)).resolves.toEqual({ ok: true });
});

test("a connection failure becomes LLM_PROVIDER_UNAVAILABLE and is not thrown", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig());
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new Error(`connect failed ${API_KEY}`);
  });

  const result = await checkProvider(provider, fetchImpl);

  expect(result).toEqual({ ok: false, code: "LLM_PROVIDER_UNAVAILABLE" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(API_KEY);
});

test("a non-retryable status is LLM_PROVIDER_UNAVAILABLE", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig());
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    return new Response("nope", { status: 401 });
  });

  await expect(checkProvider(provider, fetchImpl)).resolves.toEqual({
    ok: false,
    code: "LLM_PROVIDER_UNAVAILABLE",
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("an aborted request becomes LLM_PROVIDER_UNAVAILABLE", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig({ timeoutMs: 20 }));
  const fetchImpl: typeof fetch = (_input, init) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined) {
        reject(new Error("missing abort signal"));
        return;
      }
      const fail = (): void => {
        reject(signal.reason);
      };
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  };

  await expect(checkProvider(provider, fetchImpl)).resolves.toEqual({
    ok: false,
    code: "LLM_PROVIDER_UNAVAILABLE",
  });
});

test("the default fetch is global fetch and does not reach the network", async () => {
  process.env[API_KEY_ENV] = API_KEY;
  const provider = createProvider(llmConfig());
  const globalFetch = vi.fn<typeof fetch>(async () => {
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal("fetch", globalFetch);

  await expect(checkProvider(provider)).resolves.toEqual({ ok: true });
  expect(globalFetch).toHaveBeenCalledTimes(1);
});

test("the module does not import Stagehand", () => {
  const source = readFileSync(
    new URL("../../../src/stagehand/provider.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toMatch(/@browserbasehq\/stagehand/);
  expect(source).not.toMatch(/from\s+["']@browserbasehq\/stagehand["']/);
});
