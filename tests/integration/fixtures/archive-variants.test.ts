import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  start,
  type ArchiveVariant,
} from "../../../fixtures/archive-app/server.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { parseFlow } from "../../../src/flows/serialize.js";
import type { FlowSpec, Step } from "../../../src/flows/schema.js";
import { runAction } from "../../../src/playwright/actions.js";
import {
  startBrowser,
  type BrowserSession,
} from "../../../src/playwright/runtime.js";

const LAUNCH_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 5_000;
const MISS_TIMEOUT_MS = 1_000;
const TEST_TIMEOUT_MS = 60_000;

const flowPath = fileURLToPath(
  new URL(
    "../../../fixtures/archive-app/flows/project--archive.yml",
    import.meta.url,
  ),
);
const flow = parseFlow(readFileSync(flowPath, "utf8"), "yaml");

let session: BrowserSession;

beforeAll(async () => {
  session = await startBrowser({
    headless: true,
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
});

afterAll(async () => {
  await session?.close();
});

test("the saved flow file maps project.archive to project--archive.yml", () => {
  expect(flow.id).toBe("project.archive");
  expect(basename(flowPath)).toBe(`${flow.id.replaceAll(".", "--")}.yml`);
  expect(locatorNames(flow)).toEqual([
    "Options for Alpha",
    "Archive",
    "Archive project",
  ]);
});

test(
  "original variant replays the saved archive flow",
  async () => {
    await withVariant("original", async (page, url) => {
      await page.goto(url);
      await replay(page, flow);
      await page.getByText("No active projects.").waitFor();
      expect(await page.getByText("Alpha", { exact: true }).count()).toBe(0);
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "replaying the saved flow against renamed fails with a locator miss",
  async () => {
    await withVariant("renamed", async (page, url) => {
      await page.goto(url);
      const missed = archiveMenuStep(flow);
      const error = await replayUntilMiss(page, flow);

      expect(error).toBeInstanceOf(QaError);
      expect(error.code).toBe("LOCATOR_STALE");
      expect(error.stepId).toBe(missed.id);
      await page
        .getByRole("menuitem", { name: "Move to archive", exact: true })
        .waitFor();
      expect(
        await page
          .getByRole("menuitem", { name: "Archive", exact: true })
          .count(),
      ).toBe(0);
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "moved still exposes a confirm button named Archive project",
  async () => {
    await withVariant("moved", async (page, url) => {
      await page.goto(url);
      expect(
        await page
          .getByRole("button", { name: "Options for Alpha", exact: true })
          .count(),
      ).toBe(0);

      await page.getByRole("link", { name: "Projects", exact: true }).click();
      await openArchiveConfirm(page, "Archive");
      await expectArchiveConfirm(page);
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "modal still exposes a confirm button named Archive project",
  async () => {
    await withVariant("modal", async (page, url) => {
      await page.goto(url);
      await openArchiveConfirm(page, "Archive");

      const dialog = page.getByRole("dialog", {
        name: "Archive this project?",
        exact: true,
      });
      await dialog.waitFor();
      const confirm = dialog.getByRole("button", {
        name: "Archive project",
        exact: true,
      });
      await confirm.waitFor();
      expect(await confirm.evaluate((element) => element.tagName)).toBe(
        "BUTTON",
      );
    });
  },
  TEST_TIMEOUT_MS,
);

async function withVariant(
  variant: ArchiveVariant,
  run: (page: Page, url: string) => Promise<void>,
): Promise<void> {
  const app = await start(0, { variant });
  try {
    await run(session.page, app.url);
  } finally {
    await app.close();
  }
}

async function replay(page: Page, spec: FlowSpec): Promise<void> {
  for (const step of spec.steps) {
    await runAction(page, step, ACTION_TIMEOUT_MS);
  }
}

async function replayUntilMiss(page: Page, spec: FlowSpec): Promise<QaError> {
  const missed = archiveMenuStep(spec);
  let caught: unknown;
  for (const step of spec.steps) {
    const timeoutMs =
      step.id === missed.id ? MISS_TIMEOUT_MS : ACTION_TIMEOUT_MS;
    try {
      await runAction(page, step, timeoutMs);
    } catch (error) {
      caught = error;
      break;
    }
  }
  if (!(caught instanceof QaError)) {
    throw new Error("Saved flow replay did not miss a locator.");
  }
  return caught;
}

function archiveMenuStep(spec: FlowSpec): Step {
  const step = spec.steps.find(
    (candidate) =>
      candidate.action === "click" &&
      candidate.locator.type === "role" &&
      candidate.locator.role === "menuitem" &&
      candidate.locator.name === "Archive",
  );
  if (step === undefined) {
    throw new Error("Saved flow is missing the Archive menu step.");
  }
  return step;
}

function locatorNames(spec: FlowSpec): string[] {
  return spec.steps.map((step) => {
    if (step.action !== "click" || step.locator.type !== "role") {
      throw new Error(`Step ${step.id} is not a role click.`);
    }
    return step.locator.name;
  });
}

async function openArchiveConfirm(page: Page, menuName: string): Promise<void> {
  await page
    .getByRole("button", { name: "Options for Alpha", exact: true })
    .click();
  await page.getByRole("menuitem", { name: menuName, exact: true }).click();
}

async function expectArchiveConfirm(page: Page): Promise<void> {
  const confirm = page.getByRole("button", {
    name: "Archive project",
    exact: true,
  });
  await confirm.waitFor();
  expect(await confirm.evaluate((element) => element.tagName)).toBe("BUTTON");
}
