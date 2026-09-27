import { defineConfig } from "vitest/config";

const defaultExclude = [
  "tests/integration/**",
  "tests/e2e/**",
  "tests/live/**",
  "node_modules/**",
];

/**
 * `npx vitest run tests/live` is the manual workflow. Other commands stay on
 * the unit project, which excludes tests/live.
 */
const liveInvocation = process.argv.some((arg) => isLiveFilter(arg));

export default defineConfig({
  test: {
    include: liveInvocation
      ? ["tests/live/**/*.test.ts"]
      : ["tests/unit/**/*.test.ts"],
    exclude: liveInvocation ? ["node_modules/**"] : defaultExclude,
  },
});

function isLiveFilter(arg: string): boolean {
  const normalized = arg.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalized === "tests/live" ||
    normalized.startsWith("tests/live/") ||
    normalized.endsWith("/tests/live") ||
    normalized.includes("/tests/live/")
  );
}
