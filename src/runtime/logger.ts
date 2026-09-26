import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
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
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("..")
  ) {
    throw new Error(`Invalid log file name: ${fileName}`);
  }

  const logs = resolve(logsDir());
  const filePath = resolve(join(logs, fileName));
  if (filePath !== logs && !filePath.startsWith(`${logs}${sep}`)) {
    throw new Error(`Invalid log file name: ${fileName}`);
  }
  return filePath;
}

function appendLogLine(filePath: string, line: string): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(directory, PRIVATE_DIR_MODE);
  appendFileSync(filePath, line, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  chmodSync(filePath, PRIVATE_FILE_MODE);
}
