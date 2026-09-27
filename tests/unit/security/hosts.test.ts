import { expect, test } from "vitest";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { assertUrlAllowed } from "../../../src/security/hosts.js";

test("http://localhost:3000/path is allowed when localhost is listed and productionAllowed is false", () => {
  expect(() =>
    assertUrlAllowed(
      "http://localhost:3000/path",
      projectConfig({
        allowedHosts: ["localhost"],
        productionAllowed: false,
      }),
    ),
  ).not.toThrow();
});

test("https://app.example.com is rejected when productionAllowed is false even if the host is listed", () => {
  const error = expectPolicyBlocked(() =>
    assertUrlAllowed(
      "https://app.example.com",
      projectConfig({
        allowedHosts: ["app.example.com"],
        productionAllowed: false,
      }),
    ),
  );

  expect(error.recoveryAppropriate).toBe(false);
  expect(error.message).toContain("app.example.com");
});

test("the same host is allowed when productionAllowed is true and the host is listed", () => {
  expect(() =>
    assertUrlAllowed(
      "https://app.example.com",
      projectConfig({
        allowedHosts: ["app.example.com"],
        productionAllowed: true,
      }),
    ),
  ).not.toThrow();
});

test("http://127.0.0.1.evil.test is rejected", () => {
  const error = expectPolicyBlocked(() =>
    assertUrlAllowed(
      "http://127.0.0.1.evil.test",
      projectConfig({
        allowedHosts: ["127.0.0.1", "localhost"],
        productionAllowed: true,
      }),
    ),
  );

  expect(error.recoveryAppropriate).toBe(false);
  expect(error.message).not.toContain("evil.test is allowed");
});

test("a listed staging host stays blocked until productionAllowed is true", () => {
  const staging = projectConfig({
    allowedHosts: ["staging.example.com"],
    productionAllowed: false,
  });

  const error = expectPolicyBlocked(() =>
    assertUrlAllowed("https://staging.example.com/login", staging),
  );
  expect(error.code).toBe("POLICY_BLOCKED");
  expect(error.recoveryAppropriate).toBe(false);

  expect(() =>
    assertUrlAllowed("https://staging.example.com/login", {
      ...staging,
      application: { ...staging.application, productionAllowed: true },
    }),
  ).not.toThrow();
});

test("host comparison ignores case, a trailing dot, and the port", () => {
  const config = projectConfig({
    allowedHosts: ["LocalHost."],
    productionAllowed: false,
  });

  expect(() =>
    assertUrlAllowed("http://LOCALHOST:3000/path", config),
  ).not.toThrow();
  expect(() => assertUrlAllowed("http://localhost./health", config)).not.toThrow();
  expect(() =>
    assertUrlAllowed("http://localhost:9/path", {
      ...config,
      application: {
        ...config.application,
        allowedHosts: ["localhost:3000"],
      },
    }),
  ).not.toThrow();
});

test("loopback addresses are allowed when listed and productionAllowed is false", () => {
  expect(() =>
    assertUrlAllowed(
      "http://127.0.0.1:3000/path",
      projectConfig({
        allowedHosts: ["127.0.0.1"],
        productionAllowed: false,
      }),
    ),
  ).not.toThrow();

  expect(() =>
    assertUrlAllowed(
      "http://[::1]:8080/path",
      projectConfig({
        allowedHosts: ["[::1]"],
        productionAllowed: false,
      }),
    ),
  ).not.toThrow();

  expect(() =>
    assertUrlAllowed(
      "http://app.localhost/path",
      projectConfig({
        allowedHosts: ["app.localhost"],
        productionAllowed: false,
      }),
    ),
  ).not.toThrow();
});

test("a name that only ends with the letters localhost is not local", () => {
  const error = expectPolicyBlocked(() =>
    assertUrlAllowed(
      "http://notlocalhost/path",
      projectConfig({
        allowedHosts: ["notlocalhost"],
        productionAllowed: false,
      }),
    ),
  );

  expect(error.recoveryAppropriate).toBe(false);
});

test("an unlisted local host is rejected", () => {
  const error = expectPolicyBlocked(() =>
    assertUrlAllowed(
      "http://127.0.0.1/path",
      projectConfig({
        allowedHosts: ["localhost"],
        productionAllowed: false,
      }),
    ),
  );

  expect(error.code).toBe("POLICY_BLOCKED");
  expect(error.recoveryAppropriate).toBe(false);
});

test("a listed suffix host is still rejected while production is disabled", () => {
  const error = expectPolicyBlocked(() =>
    assertUrlAllowed(
      "http://user:secret@127.0.0.1.evil.test/path?token=secret",
      projectConfig({
        allowedHosts: ["127.0.0.1.evil.test"],
        productionAllowed: false,
      }),
    ),
  );

  expect(error.recoveryAppropriate).toBe(false);
  expect(error.message).not.toContain("secret");
  expect(JSON.stringify(error.toJSON())).not.toContain("secret");
});

test("an unparseable URL is POLICY_BLOCKED and is not a recovery case", () => {
  const error = expectPolicyBlocked(() =>
    assertUrlAllowed(
      "http://",
      projectConfig({
        allowedHosts: ["localhost"],
        productionAllowed: false,
      }),
    ),
  );

  expect(error.recoveryAppropriate).toBe(false);
  expect(error.toJSON().recoveryAppropriate).toBe(false);
});

function projectConfig(application: {
  allowedHosts: string[];
  productionAllowed: boolean;
}): ProjectConfig {
  return {
    version: 1,
    project: { id: "demo-app" },
    application: {
      baseUrl: "http://localhost:3000",
      allowedHosts: application.allowedHosts,
      productionAllowed: application.productionAllowed,
    },
    llm: {
      provider: "openai",
      model: "test-model",
      apiKeyEnv: "OPENAI_API_KEY",
      timeoutMs: 60000,
    },
    stagehand: {
      enabled: false,
      maxSteps: 30,
      recoveryEnabled: false,
    },
    playwright: {
      browser: "chromium",
      headless: true,
      workers: 1,
      timeoutMs: 30000,
    },
    evidence: {
      screenshots: "checkpoints",
      network: false,
      console: false,
      trace: "off",
      maxResponseBodyBytes: 1024,
    },
    security: {
      redactHeaders: ["authorization"],
      destructiveActionsAllowed: false,
    },
    auth: {
      workerProfiles: [],
    },
  };
}

function expectPolicyBlocked(run: () => unknown): QaError {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(QaError);
    if (!(error instanceof QaError)) {
      throw error;
    }
    expect(error.code).toBe("POLICY_BLOCKED");
    expect(error.recoveryAppropriate).toBe(false);
    return error;
  }
  throw new Error("expected POLICY_BLOCKED");
}
