import { lstatSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEffectiveConfig } from "../config/effective.js";
import type { ProjectConfig } from "../config/schema.js";
import { QaError } from "../errors/qa-error.js";

/**
 * `supported: false` means the client cannot list roots.
 * `supported: true` with an empty `roots` array is a real empty workspace.
 */
export type ListedRoots =
  | { readonly supported: false }
  | { readonly supported: true; readonly roots: readonly string[] };

export type RootLister = () => Promise<ListedRoots>;

type RootsClient = {
  listRoots?: () => Promise<{ roots?: readonly { uri?: string }[] }>;
};

const unsupportedRoots: RootLister = async () => ({ supported: false });

let rootLister: RootLister = unsupportedRoots;

export function setRootLister(lister: RootLister): void {
  rootLister = lister;
}

export function resetRootLister(): void {
  rootLister = unsupportedRoots;
}

export function rootListerFromClient(client: RootsClient): RootLister {
  return async () => {
    if (client.listRoots === undefined) {
      return { supported: false };
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
      return { supported: true, roots: paths };
    } catch {
      // The SDK throws when the client did not advertise capabilities.roots.
      return { supported: false };
    }
  };
}

/**
 * Picks the repo for one tool call.
 * An explicit path must sit inside an advertised client root.
 * One advertised root is used as-is.
 * Several roots resolve to the single root that contains `.autonomous-qa`.
 * When the client cannot list roots, the caller must supply projectRoot.
 */
export async function resolveProjectRoot(explicit: string | undefined): Promise<string> {
  const listed = await rootLister();
  if (!listed.supported) {
    return rootWithoutDiscovery(explicit);
  }
  if (explicit !== undefined) {
    return explicitRoot(explicit, listed.roots);
  }
  if (listed.roots.length === 1) {
    return requiredRoot(listed.roots[0]);
  }
  if (listed.roots.length > 1) {
    return configuredRoot(listed.roots);
  }
  throw blocked("There is no workspace root");
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

function rootWithoutDiscovery(explicit: string | undefined): string {
  if (explicit === undefined) {
    throw blocked(
      "The client does not support workspace-root discovery and projectRoot is required",
    );
  }
  return resolve(explicit);
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
    return requiredRoot(matches[0]);
  }
  const noun = matches.length === 0
    ? "No workspace root contains .autonomous-qa"
    : "Multiple workspace roots contain .autonomous-qa";
  throw blocked(`${noun}. Candidates: ${roots.join(", ")}`);
}

function requiredRoot(root: string | undefined): string {
  if (root === undefined) {
    throw blocked("There is no workspace root");
  }
  return root;
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
