import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { logsDir } from "./paths.js";

// Callers pass safe strings. This module does not redact.
export type LogSeverity = "info" | "warn" | "error";

export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type LoggerOptions = {
  fileName?: string;
};

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LOG_OPEN_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW;

export function createLogger(options: LoggerOptions = {}): Logger {
  const filePath =
    options.fileName === undefined ? undefined : resolveLogFile(options.fileName);

  const write = (severity: LogSeverity, message: string): void => {
    const line = formatLine(severity, message);
    process.stderr.write(line);
    if (filePath !== undefined) {
      appendLogLine(filePath, line);
    }
  };

  return {
    info(message: string): void {
      write("info", message);
    },
    warn(message: string): void {
      write("warn", message);
    },
    error(message: string): void {
      write("error", message);
    },
  };
}

function formatLine(severity: LogSeverity, message: string): string {
  return `${new Date().toISOString()} ${severity} ${message}\n`;
}

function resolveLogFile(fileName: string): string {
  if (
    fileName.length === 0 ||
    fileName === "." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("..")
  ) {
    throw new Error(`Invalid log file name: ${fileName}`);
  }

  const logs = resolve(logsDir());
  const filePath = resolve(join(logs, fileName));
  if (filePath === logs || !filePath.startsWith(`${logs}${sep}`)) {
    throw new Error(`Invalid log file name: ${fileName}`);
  }
  return filePath;
}

function appendLogLine(filePath: string, line: string): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(directory, PRIVATE_DIR_MODE);
  const fd = openLogFile(filePath);
  try {
    writeSync(fd, line, null, "utf8");
    fchmodSync(fd, PRIVATE_FILE_MODE);
  } finally {
    closeSync(fd);
  }
}

function openLogFile(filePath: string): number {
  try {
    return openSync(filePath, LOG_OPEN_FLAGS, PRIVATE_FILE_MODE);
  } catch (error) {
    if (!isErrno(error, "ELOOP") || !unlinkSymbolicLink(filePath)) {
      throw error;
    }
  }
  return openSync(filePath, LOG_OPEN_FLAGS, PRIVATE_FILE_MODE);
}

function unlinkSymbolicLink(filePath: string): boolean {
  try {
    const info = lstatSync(filePath);
    if (!info.isSymbolicLink()) {
      return false;
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
  unlinkSync(filePath);
  return true;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
