import { expect, test } from "vitest";
import { applyProjectDefaults } from "../../../src/config/defaults.js";
import { securitySchema } from "../../../src/config/schema.js";
import { QaError } from "../../../src/errors/qa-error.js";
import {
  assertActionAllowed,
  assertArtifactSize,
  assertDuration,
  assertStepsRemaining,
  type PolicyAction,
} from "../../../src/security/policy.js";

const TEN_MINUTES_MS = 600_000;

const disallowed = { security: { destructiveActionsAllowed: false } };
const allowed = { security: { destructiveActionsAllowed: true } };

test("step 30 with maxSteps 30 is blocked before it runs", () => {
  const error = expectQaError(
    () => assertStepsRemaining(30, 30),
    "POLICY_BLOCKED",
  );

  expect(error.message).toContain("30");
  expect(() => assertStepsRemaining(29, 30)).not.toThrow();
});

test("a run older than maxRunDurationMs throws TIMEOUT", () => {
  const startedAtMs = 1_000;
  const maxRunDurationMs = TEN_MINUTES_MS;

  const error = expectQaError(
    () =>
      assertDuration(
        startedAtMs,
        startedAtMs + maxRunDurationMs + 1,
        maxRunDurationMs,
      ),
    "TIMEOUT",
  );

  expect(error.message).toContain("maxRunDurationMs");
  expect(() =>
    assertDuration(startedAtMs, startedAtMs + maxRunDurationMs, maxRunDurationMs),
  ).not.toThrow();
});

test("omitted security.maxRunDurationMs defaults to 10 minutes", () => {
  const parsed = securitySchema.parse({
    redactHeaders: ["authorization", "cookie", "set-cookie"],
    destructiveActionsAllowed: false,
  });
  expect(parsed.maxRunDurationMs).toBe(TEN_MINUTES_MS);

  const applied = applyProjectDefaults({
    security: {
      redactHeaders: ["authorization", "cookie", "set-cookie"],
      destructiveActionsAllowed: false,
    },
  });
  expect(applied).toMatchObject({
    security: { maxRunDurationMs: TEN_MINUTES_MS },
  });

  expect(
    securitySchema.parse({
      redactHeaders: ["authorization"],
      destructiveActionsAllowed: false,
      maxRunDurationMs: 1_000,
    }).maxRunDurationMs,
  ).toBe(1_000);
});

test("an artifact above the byte cap is blocked", () => {
  expectQaError(() => assertArtifactSize(1_001, 1_000), "POLICY_BLOCKED");
  expect(() => assertArtifactSize(1_000, 1_000)).not.toThrow();
});

test("archive intent is blocked when destructive actions are disallowed", () => {
  const error = expectQaError(
    () =>
      assertActionAllowed(
        { id: "select-archive", intent: "archive" },
        disallowed,
      ),
    "POLICY_BLOCKED",
  );

  expect(error.stepId).toBe("select-archive");
  expectQaError(
    () =>
      assertActionAllowed(
        { id: "open-menu", intent: "Choose the Archive operation." },
        disallowed,
      ),
    "POLICY_BLOCKED",
  );
  expectQaError(
    () =>
      assertActionAllowed(
        { id: "confirm-archive", intent: "Confirm the dialog." },
        disallowed,
      ),
    "POLICY_BLOCKED",
  );
});

test("acceptance fixture configs must set destructiveActionsAllowed true on purpose so archive intent is allowed", () => {
  const archive: PolicyAction = {
    id: "select-archive",
    intent: "archive",
    action: "click",
    locator: { type: "role", role: "menuitem", name: "Archive" },
  };

  expect(() => assertActionAllowed(archive, allowed)).not.toThrow();
  expectQaError(() => assertActionAllowed(archive, disallowed), "POLICY_BLOCKED");
});

test("clicking a button named Save is not treated as destructive", () => {
  const save: PolicyAction = {
    id: "save-changes",
    intent: "Click the Save button",
    action: "click",
    locator: { type: "role", role: "button", name: "Save" },
  };

  expect(() => assertActionAllowed(save, disallowed)).not.toThrow();
});

function expectQaError(
  run: () => void,
  code: "POLICY_BLOCKED" | "TIMEOUT",
): QaError {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(QaError);
    if (!(error instanceof QaError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    expect(error.recoveryAppropriate).toBe(false);
    return error;
  }
  throw new Error(`expected ${code}`);
}
