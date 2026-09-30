import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

const script = "scripts/install.sh";
const planted = "install-token-must-not-print-9f3c";

test("install.sh refuses to run without a GitHub token", () => {
  const result = spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PLANTED_SECRET: planted,
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
    },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("GITHUB_TOKEN or GH_TOKEN is required");
  expect(result.stdout).not.toContain(planted);
  expect(result.stderr).not.toContain(planted);
});
