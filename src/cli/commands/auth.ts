import { captureProfile } from "../../auth/capture.js";
import { importStorageState } from "../../auth/import.js";
import { deleteProfile, listProfiles } from "../../auth/store.js";
import { QaError } from "../../errors/qa-error.js";
import type { Command } from "../types.js";

const SUBCOMMANDS = ["list", "remove", "capture", "import"] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

const OPTIONS = {
  "--project": "project",
  "--profile": "profile",
  "--url": "url",
  "--file": "file",
} as const;

type OptionName = (typeof OPTIONS)[keyof typeof OPTIONS];

type AuthFlags = Partial<Record<OptionName, string>>;

type ProfileIdentity = {
  profile: string;
  projectId: string;
};

type AuthResult = { profiles: string[] } | ProfileIdentity;

export const command: Command = {
  name: "auth",
  summary: "manage auth profiles",
  async run(argv: string[]): Promise<number> {
    try {
      const result = await execute(argv);
      console.log(JSON.stringify(result));
      return 0;
    } catch (error: unknown) {
      if (error instanceof QaError) {
        console.error(JSON.stringify(error.toJSON()));
        return 1;
      }
      throw error;
    }
  },
};

async function execute(argv: readonly string[]): Promise<AuthResult> {
  const [name, ...rest] = argv;
  const subcommand = parseSubcommand(name);
  const flags = parseFlags(rest);
  switch (subcommand) {
    case "list":
      return runList(flags);
    case "remove":
      return runRemove(flags);
    case "capture":
      return runCapture(flags);
    case "import":
      return runImport(flags);
    default: {
      const unexpected: never = subcommand;
      throw usageError(`Unknown auth subcommand: ${String(unexpected)}`);
    }
  }
}

function runList(flags: AuthFlags): { profiles: string[] } {
  return { profiles: listProfiles(required(flags, "project")) };
}

function runRemove(flags: AuthFlags): ProfileIdentity {
  const projectId = required(flags, "project");
  const profile = required(flags, "profile");
  deleteProfile(projectId, profile);
  return { profile, projectId };
}

/**
 * Opens a headed browser through `captureProfile`.
 * This command does not launch Chromium itself.
 */
async function runCapture(flags: AuthFlags): Promise<ProfileIdentity> {
  const projectId = required(flags, "project");
  const profile = required(flags, "profile");
  const startUrl = required(flags, "url");
  const captured = await captureProfile({ projectId, profile, startUrl });
  return { profile: captured.profile, projectId: captured.projectId };
}

function runImport(flags: AuthFlags): ProfileIdentity {
  const imported = importStorageState({
    projectId: required(flags, "project"),
    profile: required(flags, "profile"),
    filePath: required(flags, "file"),
  });
  return { profile: imported.profile, projectId: imported.projectId };
}

function parseSubcommand(name: string | undefined): Subcommand {
  if (name === undefined) {
    throw usageError("Missing auth subcommand");
  }
  if (isSubcommand(name)) {
    return name;
  }
  throw usageError(`Unknown auth subcommand: ${name}`);
}

function isSubcommand(name: string): name is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(name);
}

function parseFlags(argv: readonly string[]): AuthFlags {
  const flags: AuthFlags = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    const name = optionName(token);
    if (name === undefined) {
      throw unexpectedArgument(token);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`Missing ${token}`);
    }
    flags[name] = value;
    index += 2;
  }
  return flags;
}

function optionName(token: string): OptionName | undefined {
  if (!Object.hasOwn(OPTIONS, token)) {
    return undefined;
  }
  return OPTIONS[token as keyof typeof OPTIONS];
}

function required(flags: AuthFlags, name: OptionName): string {
  const value = flags[name];
  if (value === undefined || value.length === 0) {
    throw usageError(`Missing --${name}`);
  }
  return value;
}

function unexpectedArgument(token: string): QaError {
  if (token.startsWith("--")) {
    return usageError(`Unknown auth option: ${token}`);
  }
  return usageError("Unexpected auth argument");
}

function usageError(message: string): QaError {
  return new QaError({
    code: "POLICY_BLOCKED",
    message,
  });
}
