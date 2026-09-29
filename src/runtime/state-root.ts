import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectIdFromRoot } from "../config/project-id.js";
import { homeDir, projectsDir } from "./paths.js";

export type StateLocation = {
  /** Directory that contains `flows/` and `artifacts/`. */
  root: string;
  /** Real paths must stay inside this directory. */
  containment: string;
};

/**
 * Repo state when `.autonomous-qa` already exists.
 * Otherwise `~/.autonomous-qa/projects/<project-id>/`.
 * This does not create either directory.
 */
export function resolveStateLocation(projectRoot: string): StateLocation {
  const project = resolve(projectRoot);
  const repoState = join(project, ".autonomous-qa");
  if (entryExists(repoState)) {
    return { root: repoState, containment: project };
  }
  return {
    root: join(projectsDir(), projectIdFromRoot(project)),
    containment: resolve(homeDir()),
  };
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
