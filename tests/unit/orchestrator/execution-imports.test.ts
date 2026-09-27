import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { executeFlow } from "../../../src/orchestrator/execution.js";

const sourcePath = fileURLToPath(
  new URL("../../../src/orchestrator/execution.ts", import.meta.url),
);

test("execution.ts does not import stagehand or call createProvider", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(typeof executeFlow).toBe("function");
  expect(source.includes("src/stagehand/")).toBe(false);
  expect(source.includes("@browserbasehq/stagehand")).toBe(false);
  expect(source.includes("createProvider")).toBe(false);
  expect(source.toLowerCase().includes("stagehand")).toBe(false);
  expect(
    importSpecifiers(source).some((specifier) => specifier.includes("stagehand")),
  ).toBe(false);
});

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromPattern = /\bfrom\s+["']([^"']+)["']/g;
  const sideEffectPattern = /\bimport\s+["']([^"']+)["']/g;
  const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [fromPattern, sideEffectPattern, dynamicPattern]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}
