import { basename, resolve } from "node:path";
import { PROJECT_ID_PATTERN } from "./schema.js";

const PROJECT_ID_MAX_LENGTH = 63;
const FALLBACK_PROJECT_ID = "project";

/**
 * Directory names are sanitized to the project id schema
 * `/^[a-z0-9][a-z0-9-]{0,62}$/`.
 */
export function projectIdFromDirectoryName(directoryName: string): string {
  const hyphenated = directoryName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const trimmed = hyphenated.replace(/^-+/, "").replace(/-+$/, "");
  const truncated = trimmed.slice(0, PROJECT_ID_MAX_LENGTH).replace(/-+$/, "");
  if (PROJECT_ID_PATTERN.test(truncated)) {
    return truncated;
  }
  return FALLBACK_PROJECT_ID;
}

/** Project id used when the repo file does not set `project.id`. */
export function projectIdFromRoot(projectRoot: string): string {
  return projectIdFromDirectoryName(basename(resolve(projectRoot)));
}
