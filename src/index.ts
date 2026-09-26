import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
) as { version: string };

export const version: string = packageJson.version;

// Module directories later issues must use and must not rename:
// src/cli, src/mcp, src/orchestrator, src/stagehand, src/flows,
// src/playwright, src/evidence, src/config, src/security, src/errors,
// src/runtime, src/health
