import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = join(root, "dist", "cli", "main.js");

beforeAll(async () => {
  await execFileAsync(
    process.execPath,
    [join(root, "node_modules", "typescript", "lib", "tsc.js"), "-p", join(root, "tsconfig.json")],
    { cwd: root },
  );
}, 60_000);

test("a direct run through a symlink to dist/cli/main.js executes main", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-cli-symlink-"));
  const link = join(directory, "autonomous-qa");

  try {
    await symlink(relative(directory, cliEntry), link);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);

    const { stdout, stderr } = await execFileAsync(process.execPath, [link], {
      cwd: root,
      encoding: "utf8",
    });

    expect(stderr).toBe("");
    expect(stdout).toContain("auth  manage auth profiles");
    expect(stdout).toContain("help  list available commands");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an import of the module does not execute main", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-cli-import-"));
  const importer = join(directory, "importer.mjs");
  const script = [
    'import { pathToFileURL } from "node:url";',
    "const lines = [];",
    "console.log = (...args) => {",
    "  lines.push(args.map((arg) => String(arg)).join(' '));",
    "};",
    "const target = process.argv[2];",
    "if (target === undefined) {",
    '  throw new Error("missing module path");',
    "}",
    "await import(pathToFileURL(target).href);",
    'process.on("beforeExit", () => {',
    "  process.stdout.write(",
    '    `${JSON.stringify({ lines, exitCode: process.exitCode ?? null })}\\n`,',
    "  );",
    "});",
    "",
  ].join("\n");

  try {
    await writeFile(importer, script);
    const { stdout, stderr } = await execFileAsync(process.execPath, [importer, cliEntry], {
      cwd: root,
      encoding: "utf8",
    });

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ lines: [], exitCode: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
