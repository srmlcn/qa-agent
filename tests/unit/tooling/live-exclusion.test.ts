import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const LIVE_FILE = "tests/live/discovery.test.ts";
const LIST_TIMEOUT_MS = 60_000;

test(
  "the default vitest project omits the live discovery file",
  () => {
    const result = spawnSync("npx", ["vitest", "list"], {
      cwd: root,
      encoding: "utf8",
      timeout: 45_000,
      env: childEnv(),
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `npx vitest list exited ${String(result.status)}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      );
    }

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(output).toContain("tests/unit/package-version.test.ts");
    expect(output).not.toContain(LIVE_FILE);
  },
  LIST_TIMEOUT_MS,
);

test("the pull-request workflow does not mention tests/live", () => {
  const workflow = readFileSync(
    fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)),
    "utf8",
  );
  expect(workflow).not.toContain("tests/live");
});

test("the live workflow does not trigger on pull_request", () => {
  const workflow = readFileSync(
    fileURLToPath(new URL("../../../.github/workflows/live.yml", import.meta.url)),
    "utf8",
  );
  expect(workflow).not.toContain("pull_request");
});

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AUTONOMOUS_QA_LIVE;
  return env;
}
