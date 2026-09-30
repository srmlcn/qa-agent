import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test } from "vitest";

const script = "scripts/install.sh";
const scratchDirs: string[] = [];

afterEach(() => {
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a non-interactive run installs into ~/.autonomous-qa", () => {
  const home = makeHome();
  const result = runWithoutTerminal([], home);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain(`Installing into ${join(home, ".autonomous-qa")}`);
  expect(result.stdout).toContain(join(home, ".autonomous-qa"));
  expect(result.stderr).toContain(
    "https://github.com/srmlcn/qa-agent/releases/latest/download/autonomous-qa.tgz",
  );
});

test("a positional path skips the question", () => {
  const home = makeHome();
  const target = join(home, "custom-qa");
  const result = runWithoutTerminal([target], home);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(target);
  expect(result.stderr).not.toContain("[Y/n]");
});

test("a tilde path expands under the home directory", () => {
  const home = makeHome();
  const result = runWithoutTerminal(["~/custom-qa"], home);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(join(home, "custom-qa"));
});

test("a relative path is rejected before download", () => {
  const home = makeHome();
  const result = runWithoutTerminal(["relative/path"], home);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Installation path must be absolute.");
  expect(result.stderr).not.toContain("releases/latest/download");
});

test("answering n accepts an absolute installation path", () => {
  const home = makeHome();
  const target = join(home, "other-qa");
  const result = runOnTerminal(`n\n${target}\n`, home);

  expect(result.status).toBe(0);
  expect(result.output).toContain("Install autonomous-qa into");
  expect(result.output).toContain("[Y/n]");
  expect(result.output).toContain("Installation path:");
  expect(result.output).toContain(target);
});

test("answering y keeps the default installation path", () => {
  const home = makeHome();
  const result = runOnTerminal("y\n", home);

  expect(result.status).toBe(0);
  expect(result.output).toContain(join(home, ".autonomous-qa"));
  expect(result.output).not.toContain("Installation path:");
});

test("production dependencies are installed before the CLI starts", () => {
  const home = makeHome();
  const result = runWithoutTerminal([], home);
  const lines = readFileSync(join(home, "install-command-log"), "utf8").trim().split("\n");
  const npmIndex = lines.findIndex((line) => line.startsWith("npm "));
  const installIndex = lines.findIndex((line) => line.includes("/dist/cli/main.js"));
  const cwd = lines[npmIndex + 1]?.slice("cwd ".length);

  expect(result.status).toBe(0);
  expect(lines[npmIndex]).toBe("npm ci --omit=dev --ignore-scripts --no-audit --no-fund");
  expect(cwd).toBeTruthy();
  expect(installIndex).toBeGreaterThan(npmIndex);
  expect(lines[installIndex]).toBe(`node ${cwd}/dist/cli/main.js install`);
});

test("install.sh refuses to run without npm", () => {
  const home = makeHome();
  const bin = mkdtempSync(join(tmpdir(), "qa-install-node-"));
  scratchDirs.push(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const pathWithoutNpm = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir.length > 0 && !existsSync(join(dir, "npm")))
    .join(delimiter);
  const result = spawnSync("setsid", ["sh", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      AUTONOMOUS_QA_HOME: "",
      PATH: `${bin}${delimiter}${pathWithoutNpm}`,
    },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("npm is required.");
  expect(result.stderr).not.toContain("releases/latest/download");
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "qa-install-home-"));
  scratchDirs.push(home);
  return home;
}

function runWithoutTerminal(
  args: string[],
  home: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("setsid", ["sh", script, ...args], {
    encoding: "utf8",
    env: testEnv(home),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runOnTerminal(
  answers: string,
  home: string,
): { status: number; output: string } {
  const result = spawnSync("python3", ["-c", PTY_DRIVER, answers, script], {
    encoding: "utf8",
    env: testEnv(home),
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  };
}

function testEnv(home: string): NodeJS.ProcessEnv {
  const scratch = mkdtempSync(join(tmpdir(), "qa-install-bin-"));
  scratchDirs.push(scratch);
  const bin = join(scratch, "bin");
  const packageDir = join(scratch, "package");
  mkdirSync(join(packageDir, "dist", "cli"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(packageDir, "dist", "cli", "main.js"),
    "console.log(process.env.AUTONOMOUS_QA_HOME);\n",
  );
  writeFileSync(join(packageDir, "package.json"), '{"name":"autonomous-qa","private":true}\n');
  writeFileSync(join(packageDir, "package-lock.json"), '{"lockfileVersion":3}\n');
  const tarball = join(scratch, "autonomous-qa.tgz");
  const packed = spawnSync(
    "tar",
    ["-czf", tarball, "-C", packageDir, "dist", "package.json", "package-lock.json"],
    { encoding: "utf8" },
  );
  if (packed.status !== 0) {
    throw new Error(packed.stderr);
  }
  writeFileSync(join(bin, "curl"), curlStub(tarball), { mode: 0o755 });
  writeFileSync(join(bin, "npm"), npmStub(), { mode: 0o755 });
  writeFileSync(join(bin, "node"), nodeStub(process.execPath), { mode: 0o755 });
  return {
    ...process.env,
    HOME: home,
    AUTONOMOUS_QA_HOME: "",
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
}

function curlStub(tarball: string): string {
  return String.raw`#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
  fi
  case "$arg" in
    http*) printf '%s\n' "$arg" >&2 ;;
  esac
  prev="$arg"
done
cp ${shellQuote(tarball)} "$out"
`;
}

function npmStub(): string {
  return `#!/bin/sh
log="\${HOME}/install-command-log"
{
  printf 'npm'
  for arg in "$@"; do
    printf ' %s' "$arg"
  done
  printf '\\n'
  printf 'cwd %s\\n' "$PWD"
} >> "$log"
if [ ! -f "$PWD/package.json" ] || [ ! -f "$PWD/package-lock.json" ] || [ ! -f "$PWD/dist/cli/main.js" ]; then
  echo "production install ran before the release was extracted" >&2
  exit 1
fi
exit 0
`;
}

function nodeStub(realNode: string): string {
  return `#!/bin/sh
log="\${HOME}/install-command-log"
{
  printf 'node'
  for arg in "$@"; do
    printf ' %s' "$arg"
  done
  printf '\\n'
} >> "$log"
exec ${shellQuote(realNode)} "$@"
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const PTY_DRIVER = String.raw`
import os, pty, select, sys
answers = sys.argv[1].encode()
script = sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("sh", ["sh", script])
sent_choice = False
sent_path = False
seen = b""
while True:
    readable, _, _ = select.select([fd], [], [], 5)
    if not readable:
        os.kill(pid, 9)
        sys.stderr.write("timed out waiting for the install prompt\n")
        sys.exit(2)
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    sys.stdout.buffer.write(data)
    seen += data
    if (not sent_choice) and b"[Y/n]" in seen:
        first, _, rest = answers.partition(b"\n")
        os.write(fd, first + b"\n")
        answers = rest
        sent_choice = True
    elif sent_choice and (not sent_path) and b"Installation path:" in seen:
        os.write(fd, answers)
        sent_path = True
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code)
`;
