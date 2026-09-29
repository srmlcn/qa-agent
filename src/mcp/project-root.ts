import { lstatSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEffectiveConfig } from "../config/effective.js";
import type { ProjectConfig } from "../config/schema.js";
import { QaError } from "../errors/qa-error.js";

export type RootLister = () => Promise<readonly string[]>;

type RootsClient = {
  listRoots?: () => Promise<{ roots?: readonly { uri?: string }[] }>;
};

const emptyRoots: RootLister = async () => [];

let rootLister: RootLister = emptyRoots;

export function setRootLister(lister: RootLister): void {
  rootLister = lister;
}

export function resetRootLister(): void {
  rootLister = emptyRoots;
}

export function rootListerFromClient(client: RootsClient): RootLister {
  return async () => {
    if (client.listRoots === undefined) {
      return [];
    }
    try {
      const listed = await client.listRoots();
      const paths: string[] = [];
      for (const root of listed.roots ?? []) {
        const path = pathFromRootUri(root.uri);
        if (path !== undefined) {
          paths.push(path);
        }
      }
      return paths;
    } catch {
      return [];
    }
  };
}

/**
 * Picks the repo for one tool call.
 * An explicit path must sit inside a client root.
 * One client root is used as-is.
 * Several roots resolve to the single root that contains `.autonomous-qa`.
 * With no client roots, the process working directory is the fallback.
 */
export async function resolveProjectRoot(explicit: string | undefined): Promise<string> {
  const roots = await rootLister();
  if (explicit !== undefined) {
    return explicitRoot(explicit, roots);
  }
  if (roots.length === 1) {
    return roots[0] ?? resolve(process.cwd());
  }
  if (roots.length > 1) {
    return configuredRoot(roots);
  }
  return resolve(process.cwd());
}

export async function loadToolConfig(
  explicit: string | undefined,
): Promise<{ projectRoot: string; config: ProjectConfig }> {
  const projectRoot = await resolveProjectRoot(explicit);
  return {
    projectRoot,
    config: loadEffectiveConfig(projectRoot).config,
  };
}

function explicitRoot(explicit: string, roots: readonly string[]): string {
  if (roots.length === 0) {
    throw blocked("projectRoot requires a workspace root");
  }
  const resolved = resolve(explicit);
  if (!roots.some((root) => isInside(root, resolved))) {
    throw blocked(`projectRoot is outside the workspace roots: ${roots.join(", ")}`);
  }
  return resolved;
}

function configuredRoot(roots: readonly string[]): string {
  const matches = roots.filter((root) => hasOverrideDirectory(root));
  if (matches.length === 1) {
    return matches[0] ?? roots[0] ?? resolve(process.cwd());
  }
  const noun = matches.length === 0
    ? "No workspace root contains .autonomous-qa"
    : "Multiple workspace roots contain .autonomous-qa";
  throw blocked(`${noun}. Candidates: ${roots.join(", ")}`);
}

function hasOverrideDirectory(root: string): boolean {
  try {
    lstatSync(join(root, ".autonomous-qa"));
    return true;
  } catch {
    return false;
  }
}

function isInside(root: string, candidate: string): boolean {
  const base = canonicalize(root);
  const target = canonicalize(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}

function canonicalize(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function pathFromRootUri(uri: string | undefined): string | undefined {
  if (uri === undefined || uri.length === 0) {
    return undefined;
  }
  if (uri.startsWith("file:")) {
    return fileURLToPath(uri);
  }
  return resolve(uri);
}

function blocked(message: string): QaError {
  return new QaError({
    code: "POLICY_BLOCKED",
    message,
  });
}
