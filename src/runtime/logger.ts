import {
  chmodSync,
  closeSync,
  constants,
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
// O_NOFOLLOW is not enforced on Windows, so it is not part of this open.
const LOG_OPEN_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;

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
  const fd = openRegularLogFile(filePath);
  try {
    writeSync(fd, line, null, "utf8");
  } finally {
    closeSync(fd);
  }
  restrictRegularLogFile(filePath);
}

function openRegularLogFile(filePath: string): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    removeSymbolicLink(filePath);
    const fd = openSync(filePath, LOG_OPEN_FLAGS, PRIVATE_FILE_MODE);
    if (isRegularFile(filePath)) {
      return fd;
    }
    // Windows can follow a symlink that appeared between lstat and open.
    closeSync(fd);
  }
  throw new Error(`Log path is not a regular file: ${filePath}`);
}

function restrictRegularLogFile(filePath: string): void {
  if (!isRegularFile(filePath)) {
    throw new Error(`Log path is not a regular file: ${filePath}`);
  }
  chmodSync(filePath, PRIVATE_FILE_MODE);
}

function removeSymbolicLink(filePath: string): void {
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    unlinkSync(filePath);
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    const info = lstatSync(filePath);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
