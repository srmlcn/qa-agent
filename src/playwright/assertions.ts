import { expect } from "playwright/test";
import type { Locator, Page } from "playwright";
import { QaError } from "../errors/qa-error.js";
import type { Assertion, Locator as FlowLocator } from "../flows/schema.js";
import { redactBody } from "../security/redaction.js";
import { runAction } from "./actions.js";
import { classifyPlaywrightError } from "./errors.js";
import { toLocator } from "./locators.js";

const MAX_MESSAGE_CHARS = 500;

type SequenceAssertion = Extract<Assertion, { type: "sequence" }>;
type SequenceEntry = SequenceAssertion["sequence"][number];

/**
 * Runs one FlowSpec assertion.
 * A failed expectation is ASSERTION_FAILED and is not recoverable.
 * A locator miss while resolving the target is LOCATOR_STALE.
 * Nested sequences are rejected even when they skipped schema validation.
 */
export async function runAssertion(
  page: Page,
  assertion: Assertion,
  timeoutMs: number,
): Promise<void> {
  await performAssertion(page, assertion, timeoutMs, assertion.id);
}

async function performAssertion(
  page: Page,
  assertion: Assertion,
  timeoutMs: number,
  stepId: string | undefined,
): Promise<void> {
  switch (assertion.type) {
    case "visible":
      await expectVisible(page, assertion.locator, timeoutMs, stepId);
      return;
    case "not-visible":
      await expectNotVisible(page, assertion.locator, timeoutMs, stepId);
      return;
    case "text":
      await expectText(
        page,
        assertion.locator,
        assertion.text,
        timeoutMs,
        stepId,
      );
      return;
    case "url":
      await expectUrl(page, assertion.url, timeoutMs, stepId);
      return;
    case "sequence":
      await runSequence(page, assertion, timeoutMs, stepId);
      return;
    default:
      throw unsupportedAssertion(assertion, stepId);
  }
}

/**
 * The target is resolved before the expectation. A miss is LOCATOR_STALE.
 * Only a resolved locator that fails the expectation is ASSERTION_FAILED.
 */
async function expectVisible(
  page: Page,
  locator: FlowLocator,
  timeoutMs: number,
  stepId: string | undefined,
): Promise<void> {
  const target = await resolveLocator(page, locator, timeoutMs, stepId);
  try {
    await expect(target).toBeVisible({ timeout: timeoutMs });
  } catch (error) {
    rethrowAssertionError(error, stepId);
  }
}

/**
 * Hidden and detached both satisfy not-visible. A visible match does not.
 * An ambiguous match never resolves, so it stays a locator failure.
 */
async function expectNotVisible(
  page: Page,
  locator: FlowLocator,
  timeoutMs: number,
  stepId: string | undefined,
): Promise<void> {
  const target = toLocator(page, locator);
  try {
    await expect(target).toBeHidden({ timeout: timeoutMs });
  } catch (error) {
    rethrowAssertionError(error, stepId);
  }
}

async function expectText(
  page: Page,
  locator: FlowLocator,
  text: string,
  timeoutMs: number,
  stepId: string | undefined,
): Promise<void> {
  const target = await resolveLocator(page, locator, timeoutMs, stepId);
  try {
    await expect(target).toHaveText(text, { timeout: timeoutMs });
  } catch (error) {
    rethrowAssertionError(error, stepId);
  }
}

async function expectUrl(
  page: Page,
  url: string,
  timeoutMs: number,
  stepId: string | undefined,
): Promise<void> {
  const expected = url.includes("*") ? urlWildcard(url) : url;
  try {
    await expect(page).toHaveURL(expected, { timeout: timeoutMs });
  } catch (error) {
    rethrowAssertionError(error, stepId);
  }
}

async function runSequence(
  page: Page,
  assertion: SequenceAssertion,
  timeoutMs: number,
  stepId: string | undefined,
): Promise<void> {
  for (const entry of assertion.sequence) {
    if (isNestedSequence(entry)) {
      throw nestedSequenceError(entry, stepId);
    }
    if (isAssertionEntry(entry)) {
      await performAssertion(page, entry, timeoutMs, entry.id ?? stepId);
      continue;
    }
    await runAction(page, entry, timeoutMs);
  }
}

async function resolveLocator(
  page: Page,
  locator: FlowLocator,
  timeoutMs: number,
  stepId: string | undefined,
): Promise<Locator> {
  const target = toLocator(page, locator);
  try {
    await target.waitFor({ state: "attached", timeout: timeoutMs });
  } catch (error) {
    if (error instanceof QaError) {
      throw error;
    }
    throw classifyPlaywrightError(error, { stepId });
  }
  return target;
}

function rethrowAssertionError(
  error: unknown,
  stepId: string | undefined,
): never {
  if (error instanceof QaError) {
    throw error;
  }
  if (isExpectMismatch(error)) {
    throw assertionFailed(stepId, error);
  }
  throw classifyPlaywrightError(error, { stepId });
}

function isExpectMismatch(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (/strict mode violation/i.test(error.message)) {
    return false;
  }
  return error.message.includes("expect(");
}

function assertionFailed(
  stepId: string | undefined,
  error: unknown,
): QaError {
  const raw =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "Assertion failed.";
  return new QaError({
    code: "ASSERTION_FAILED",
    message: redactBody(raw, MAX_MESSAGE_CHARS),
    ...(stepId === undefined ? {} : { stepId }),
  });
}

function isNestedSequence(entry: SequenceEntry): boolean {
  return (entry as { type?: unknown }).type === "sequence";
}

function isAssertionEntry(
  entry: SequenceEntry,
): entry is Extract<SequenceEntry, { type: string }> {
  return typeof (entry as { type?: unknown }).type === "string";
}

function nestedSequenceError(
  entry: SequenceEntry,
  fallback: string | undefined,
): QaError {
  const id = (entry as { id?: unknown }).id;
  const stepId = typeof id === "string" && id.length > 0 ? id : fallback;
  return new QaError({
    code: "FLOW_VALIDATION_FAILED",
    message: "Nested sequence assertions are not allowed.",
    ...(stepId === undefined ? {} : { stepId }),
  });
}

/**
 * `*` matches one non-empty segment and does not cross `/`.
 * The rest of the URL is literal.
 */
function urlWildcard(pattern: string): RegExp {
  const source = pattern.split("*").map(escapeRegExp).join("[^/]+");
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unsupportedAssertion(
  assertion: never,
  stepId: string | undefined,
): QaError {
  const type = (assertion as { type?: unknown }).type;
  return new QaError({
    code: "FLOW_VALIDATION_FAILED",
    message: `Unsupported assertion type "${String(type)}".`,
    ...(stepId === undefined ? {} : { stepId }),
  });
}
