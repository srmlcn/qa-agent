import { expect, test } from "vitest";
import { EXPECTED_EVIDENCE_CAPTURE } from "../../../src/config/evidence-defaults.js";
import {
  resolveScreenshotPlan,
  shouldShowCursor,
} from "../../../src/evidence/screenshots.js";

const cursor = EXPECTED_EVIDENCE_CAPTURE.cursor;

test("resolveScreenshotPlan returns settle delay default", () => {
  const plan = resolveScreenshotPlan({
    screenshots: "checkpoints",
    network: true,
    console: true,
    trace: "off",
    maxResponseBodyBytes: 1024,
    ...EXPECTED_EVIDENCE_CAPTURE,
  });
  expect(plan.settleDelayMs).toBe(1500);
});

test("shouldShowCursor matrix for auto mode", () => {
  const base = { cursor, showCursorOverride: undefined as boolean | undefined };
  expect(shouldShowCursor({ ...base, stepAction: "click" })).toBe(true);
  expect(shouldShowCursor({ ...base, stepAction: "hover" })).toBe(true);
  expect(shouldShowCursor({ ...base, stepAction: "select" })).toBe(true);
  expect(shouldShowCursor({ ...base, stepAction: "check" })).toBe(true);
  expect(shouldShowCursor({ ...base, stepAction: "goto" })).toBe(false);
  expect(shouldShowCursor({ ...base, stepAction: "reload" })).toBe(false);
  expect(shouldShowCursor({ ...base, stepAction: "fill" })).toBe(false);
  expect(shouldShowCursor({ ...base, stepAction: "press" })).toBe(false);
  expect(
    shouldShowCursor({ ...base, stepAction: "waitFor", stepLocator: undefined }),
  ).toBe(false);
  expect(
    shouldShowCursor({
      ...base,
      stepAction: "waitFor",
      stepLocator: { type: "text", text: "Save" },
    }),
  ).toBe(true);
  expect(
    shouldShowCursor({
      ...base,
      stepAction: "click",
      stepLocator: { type: "css", selector: ".btn" },
    }),
  ).toBe(true);
  expect(shouldShowCursor({ ...base, isFailure: true })).toBe(true);
});

test("shouldShowCursor honors overrides", () => {
  expect(
    shouldShowCursor({
      cursor: { ...cursor, mode: "always" },
      stepAction: "goto",
    }),
  ).toBe(true);
  expect(
    shouldShowCursor({
      cursor: { ...cursor, mode: "never" },
      stepAction: "click",
    }),
  ).toBe(false);
  expect(
    shouldShowCursor({
      cursor,
      stepAction: "goto",
      showCursorOverride: true,
    }),
  ).toBe(true);
  expect(
    shouldShowCursor({
      cursor,
      stepAction: "click",
      showCursorOverride: false,
    }),
  ).toBe(false);
});
