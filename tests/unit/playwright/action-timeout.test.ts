import type { Page } from "playwright";
import { expect, test, vi } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import { runAction } from "../../../src/playwright/actions.js";

test("a locator-backed waitFor uses the configured timeout", async () => {
  const waitFor = vi.fn(async () => undefined);
  const page = {
    getByText() {
      return { waitFor };
    },
  } as unknown as Page;

  await runAction(
    page,
    {
      id: "wait-option",
      intent: "Wait until the option is visible",
      action: "waitFor",
      locator: { type: "text", text: "Quarterly" },
    },
    45_000,
  );

  expect(waitFor).toHaveBeenCalledTimes(1);
  expect(waitFor).toHaveBeenCalledWith({
    state: "visible",
    timeout: 45_000,
  });
});

test("a millisecond waitFor keeps the 10 second cap when the action timeout is longer", async () => {
  const waitForTimeout = vi.fn(async () => undefined);
  const page = { waitForTimeout } as unknown as Page;

  const pending = runAction(
    page,
    {
      id: "wait-too-long",
      intent: "Pause longer than the cap",
      action: "waitFor",
      value: "10001",
    },
    60_000,
  );

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "POLICY_BLOCKED",
    stepId: "wait-too-long",
  });
  expect(waitForTimeout).not.toHaveBeenCalled();
});
