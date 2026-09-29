import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("the validator source does not import stagehand", () => {
  const source = readFileSync(
    new URL("../../../src/flows/validator.ts", import.meta.url),
    "utf8",
  );

  expect(source).not.toContain("@browserbasehq/stagehand");
  for (const specifier of importSpecifiers(source)) {
    expect(specifier).not.toContain("stagehand");
  }
});

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromPattern = /\bfrom\s+["']([^"']+)["']/g;
  const sideEffectPattern = /\bimport\s+["']([^"']+)["']/g;
  for (const pattern of [fromPattern, sideEffectPattern]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}
