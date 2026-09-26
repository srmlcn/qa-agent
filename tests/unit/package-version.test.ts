import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { version } from "../../src/index.js";

test("exported version matches package.json", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  expect(version).toBe(packageJson.version);
});
