import { z } from "zod";
import { captureProfile, type CapturedProfile } from "../../auth/capture.js";
import { loadProjectConfig } from "../../config/load-project.js";
import type { McpTool } from "../load-tools.js";

const schema = z.object({
  projectId: z.string().min(1),
  profile: z.string().min(1),
  startUrl: z.string().min(1),
  projectRoot: z.string().min(1).optional(),
});

/**
 * Starts headed auth capture. The host allowlist runs inside `captureProfile`
 * because this handler passes project config. The result is the profile name.
 */
export const tool = {
  name: "qa.capture_auth",
  description:
    "Start headed auth capture and return the profile name. Does not return cookies.",
  schema,
  async handler(args: unknown): Promise<CapturedProfile> {
    const input = schema.parse(args);
    const projectRoot = input.projectRoot ?? process.cwd();
    return captureProfile({
      projectId: input.projectId,
      profile: input.profile,
      startUrl: input.startUrl,
      config: loadProjectConfig(projectRoot),
    });
  },
} satisfies McpTool;
