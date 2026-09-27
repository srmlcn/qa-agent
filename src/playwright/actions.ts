import type { Page } from "playwright";
import { QaError } from "../errors/qa-error.js";
import type { Step } from "../flows/schema.js";
import { classifyPlaywrightError } from "./errors.js";
import { toLocator } from "./locators.js";

/** A timed wait longer than this is refused and never started. */
const MAX_WAIT_MS = 10_000;

/**
 * Runs one FlowSpec action.
 * Playwright failures are returned as QaError with the step id.
 * A millisecond wait longer than 10 seconds is refused before the timer starts.
 */
export async function runAction(
  page: Page,
  step: Step,
  timeoutMs: number,
): Promise<void> {
  try {
    await performAction(page, step, timeoutMs);
  } catch (error) {
    if (error instanceof QaError || isAssertionFailure(error)) {
      throw error;
    }
    throw classifyPlaywrightError(error, { stepId: step.id });
  }
}

async function performAction(
  page: Page,
  step: Step,
  timeoutMs: number,
): Promise<void> {
  switch (step.action) {
    case "goto":
      await page.goto(step.value, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      return;
    case "reload":
      await page.reload({ timeout: timeoutMs });
      return;
    case "click":
      await toLocator(page, step.locator).click({ timeout: timeoutMs });
      return;
    case "fill":
      await toLocator(page, step.locator).fill(step.value, {
        timeout: timeoutMs,
      });
      return;
    case "press":
      await toLocator(page, step.locator).press(step.value, {
        timeout: timeoutMs,
      });
      return;
    case "select":
      await toLocator(page, step.locator).selectOption(step.value, {
        timeout: timeoutMs,
      });
      return;
    case "check":
      await toLocator(page, step.locator).check({ timeout: timeoutMs });
      return;
    case "uncheck":
      await toLocator(page, step.locator).uncheck({ timeout: timeoutMs });
      return;
    case "waitFor":
      await waitForStep(page, step, timeoutMs);
      return;
    default:
      throw unsupportedAction(step);
  }
}

async function waitForStep(
  page: Page,
  step: Extract<Step, { action: "waitFor" }>,
  timeoutMs: number,
): Promise<void> {
  if (step.locator !== undefined) {
    await toLocator(page, step.locator).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    return;
  }

  const requested = parseMillisecondWait(step.value);
  if (requested === undefined) {
    throw new QaError({
      code: "FLOW_VALIDATION_FAILED",
      message:
        "waitFor without a locator requires an integer millisecond value.",
      stepId: step.id,
    });
  }
  if (requested > MAX_WAIT_MS) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: waitCapMessage(step.value ?? String(requested)),
      stepId: step.id,
    });
  }

  await page.waitForTimeout(Math.min(requested, MAX_WAIT_MS));
}

/**
 * Accepts a base-10 integer string. Values above the cap become `cap + 1`
 * so the caller can refuse them without starting a timer.
 */
function parseMillisecondWait(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(MAX_WAIT_MS)) {
    return MAX_WAIT_MS + 1;
  }
  return Number(parsed);
}

function waitCapMessage(value: string): string {
  const shown =
    value.length > 8 ? "the requested duration" : `${Number(value)}ms`;
  return `waitFor of ${shown} exceeds the ${MAX_WAIT_MS}ms cap.`;
}

function isAssertionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "AssertionError";
}

function unsupportedAction(step: never): never {
  const action = (step as { action?: unknown }).action;
  const id = (step as { id?: string }).id;
  throw new QaError({
    code: "FLOW_VALIDATION_FAILED",
    message: `Unsupported action "${String(action)}".`,
    ...(id === undefined ? {} : { stepId: id }),
  });
}
