import { collectHealth, type HealthReport } from "../../health/status.js";
import { loadUserEnv } from "../../runtime/user-env.js";
import type { Command } from "../types.js";

export const command: Command = {
  name: "doctor",
  summary: "report installation health",
  async run(): Promise<number> {
    loadUserEnv();
    const health = collectHealth(process.cwd());
    console.log(JSON.stringify(health));
    return healthExitCode(health);
  },
};

/**
 * A missing API key is a problem string and still exits 0.
 * A missing repo file is not a failure when global settings load.
 * The user install is Node, home permissions, Chromium, the copied app, and user MCP.
 */
function healthExitCode(health: HealthReport): number {
  if (!health.userInstallOk) {
    return 1;
  }
  return 0;
}
