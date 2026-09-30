import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const tarball = join(scratch, "autonomous-qa.tgz");
  const packed = spawnSync("tar", ["-czf", tarball, "-C", packageDir, "dist"], {
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    throw new Error(packed.stderr);
  }
  writeFileSync(join(bin, "curl"), curlStub(tarball), { mode: 0o755 });
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
