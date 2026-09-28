import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { assertArtifactPath } from "../../../src/evidence/screenshots.js";

const roots: string[] = [];
let previousHome: string | undefined;

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  previousHome = undefined;
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

test("accepts a file inside an existing artifact directory", () => {
  const root = makeRoot();
  const dest = join(root, "artifacts");
  mkdirSync(dest);

  expect(assertArtifactPath(join(dest, "step.png"))).toBe(
    join(dest, "step.png"),
  );
});

test("refuses a symlink at the screenshot destination", () => {
  const root = makeRoot();
  const dest = join(root, "artifacts");
  const outside = join(root, "outside");
  mkdirSync(dest);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.png"), "secret");
  symlinkSync(join(outside, "secret.png"), join(dest, "step.png"));

  expect(() => assertArtifactPath(join(dest, "step.png"))).toThrow(
    /symlinked artifact path/,
  );
});

test("refuses a symlink ancestor outside the artifact directory", () => {
  const root = makeRoot();
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(root, "artifacts"));

  expect(() =>
    assertArtifactPath(join(root, "artifacts", "step.png")),
  ).toThrow(/outside the artifact directory/);
});

test("refuses a symlink ancestor inside the auth home", () => {
  const root = makeRoot();
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  process.env.AUTONOMOUS_QA_HOME = root;
  const auth = join(root, "auth");
  mkdirSync(auth);
  symlinkSync(auth, join(root, "artifacts"));

  expect(() =>
    assertArtifactPath(join(root, "artifacts", "step.png")),
  ).toThrow(/outside the artifact directory|cookie jar/);
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qa-shots-"));
  roots.push(root);
  return root;
}
