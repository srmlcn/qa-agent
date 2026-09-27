import { collectHealth, type HealthReport } from "../../health/status.js";
import type { Command } from "../types.js";

export const command: Command = {
  name: "doctor",
  summary: "report installation health",
  async run(): Promise<number> {
    const health = collectHealth(process.cwd());
    console.log(JSON.stringify(health));
    return healthExitCode(health);
  },
};

/**
 * A missing LLM key is a problem string and still exits 0.
 * Replay-only environments do not have a provider key.
 */
function healthExitCode(health: HealthReport): number {
  if (!health.configOk || !health.nodeOk || !health.homeOk || !health.browserOk) {
    return 1;
  }
  return 0;
}
