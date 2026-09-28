import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import type { BrowserContext } from "playwright";
import type { ProjectConfig } from "../config/schema.js";
import {
  redactBody,
  redactCookies,
  redactHeaders,
} from "../security/redaction.js";
import { assertArtifactPath } from "./screenshots.js";

const TRACE_ZIP = "trace.zip";
const TRACE_NAME_PREFIX = "qa-";

/** v0.1 config evidence.trace. Only `on-failure` keeps a zip, and only after a failure. */
export type TraceMode = ProjectConfig["evidence"]["trace"];

export type StopTraceOptions = {
  failed: boolean;
  dest: string;
  /** Defaults to `on-failure`, the v0.1 config requirement. */
  mode?: TraceMode;
  /**
   * Header names whose values are removed from a saved zip.
   * Defaults to authorization, cookie, and set-cookie.
   */
  redactHeaderNames?: readonly string[];
};

const inProgressNames = new WeakMap<BrowserContext, string>();

/**
 * Starts a Playwright trace when the run begins.
 * The in-progress trace is removed by {@link stopTrace}.
 */
export async function startTrace(context: BrowserContext): Promise<void> {
  const name = `${TRACE_NAME_PREFIX}${randomBytes(8).toString("hex")}`;
  inProgressNames.set(context, name);
  try {
    await context.tracing.start({
      name,
      screenshots: true,
      snapshots: true,
    });
  } catch (error) {
    inProgressNames.delete(context);
    throw error;
  }
}

/**
 * Saves `trace.zip` only when the run failed and config trace mode is
 * `on-failure`. A passed run, or trace mode `off`, deletes the in-progress
 * trace and leaves no zip. A saved zip has cookie values and configured
 * secret headers removed. Returns the zip path. Zip bytes stay on disk.
 */
export async function stopTrace(
  context: BrowserContext,
  options: StopTraceOptions,
): Promise<string | undefined> {
  const mode = options.mode ?? "on-failure";
  const save = options.failed === true && mode === "on-failure";
  const name = inProgressNames.get(context);
  inProgressNames.delete(context);

  let saved: string | undefined;
  let failure: unknown;
  if (save) {
    try {
      saved = prepareZipPath(options.dest);
    } catch (error) {
      failure = error;
    }
  }

  let result: string | undefined;
  try {
    if (saved === undefined) {
      await context.tracing.stop();
      removeRegularFile(join(options.dest, TRACE_ZIP));
    } else {
      await context.tracing.stop({ path: saved });
      redactSavedTrace(saved, options.redactHeaderNames);
      result = saved;
    }
  } catch (error) {
    if (failure === undefined) {
      failure = error;
    }
  } finally {
    if (name !== undefined) {
      deleteInProgressTrace(name);
    }
    if (failure !== undefined) {
      removeRegularFile(join(options.dest, TRACE_ZIP));
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
  return result;
}

function prepareZipPath(dest: string): string {
  const filePath = assertArtifactPath(join(dest, TRACE_ZIP));
  mkdirSync(dirname(filePath), { recursive: true });
  return filePath;
}

/**
 * Playwright discards a trace that is stopped without a path, but it leaves
 * the `.trace` and `.network` files in the browser artifacts directory until
 * the browser exits. A passed run removes those files itself.
 */
function deleteInProgressTrace(name: string): void {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("playwright-artifacts-")) {
      continue;
    }
    removeNamedTraceFiles(join(root, entry), name);
  }
  removeRegularFile(join(root, `${name}.stacks`));
}

function removeNamedTraceFiles(directory: string, name: string): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!isInProgressTraceFile(entry, name)) {
      continue;
    }
    removeRegularFile(join(directory, entry));
  }
}

function isInProgressTraceFile(entry: string, name: string): boolean {
  if (
    entry === `${name}.trace` ||
    entry === `${name}.network` ||
    entry === `${name}.stacks`
  ) {
    return true;
  }
  if (!entry.startsWith(`${name}-`)) {
    return false;
  }
  return (
    entry.endsWith(".trace") ||
    entry.endsWith(".network") ||
    entry.endsWith(".stacks")
  );
}

function removeRegularFile(filePath: string): void {
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return;
  }
  rmSync(filePath);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
const UTF8_FLAG = 0x800;

type ZipEntry = {
  name: string;
  data: Buffer;
};

type NameValue = {
  name: string;
  value: string;
};

/**
 * Playwright writes request headers, cookies, storage state, and action
 * parameters into the zip. Network evidence already redacts those facts;
 * the saved archive is rewritten the same way. When the archive cannot be
 * rewritten, secret-bearing network entries are omitted instead.
 */
export function redactSavedTrace(
  filePath: string,
  headerNames: readonly string[] | undefined,
): void {
  const original = readFileSync(filePath);
  const entries = readZipEntries(original);
  let next: Buffer;
  try {
    const sanitized = entries.map((entry) => ({
      name: entry.name,
      data: sanitizeEntry(entry.name, entry.data, headerNames),
    }));
    next = writeZip(sanitized);
    if (!zipRoundTripMatches(next, sanitized)) {
      throw new Error("Trace zip round-trip mismatch");
    }
  } catch {
    next = writeZip(entriesWithoutSecrets(entries, headerNames));
  }
  replaceFile(filePath, next);
}

function entriesWithoutSecrets(
  entries: readonly ZipEntry[],
  headerNames: readonly string[] | undefined,
): ZipEntry[] {
  const kept: ZipEntry[] = [];
  for (const entry of entries) {
    if (isSecretNetworkEntry(entry.name)) {
      continue;
    }
    if (isBinaryPayload(entry.name, entry.data)) {
      kept.push(entry);
      continue;
    }
    try {
      kept.push({
        name: entry.name,
        data: Buffer.from(redactJsonText(entry.data.toString("utf8"), headerNames), "utf8"),
      });
    } catch {
      // Drop text that could not be redacted rather than keep the secret.
    }
  }
  return kept;
}

function isSecretNetworkEntry(name: string): boolean {
  return (
    name === "trace.network" ||
    name.endsWith(".network") ||
    name.startsWith("resources/")
  );
}

function sanitizeEntry(
  name: string,
  data: Buffer,
  headerNames: readonly string[] | undefined,
): Buffer {
  if (name.endsWith("/") || isBinaryPayload(name, data)) {
    return data;
  }
  const text = data.toString("utf8");
  if (name.startsWith("resources/")) {
    return Buffer.from(redactCapturedText(text), "utf8");
  }
  return Buffer.from(redactJsonText(text, headerNames), "utf8");
}

function redactCapturedText(text: string): string {
  return redactBody(redactCookies(text), Number.POSITIVE_INFINITY);
}

function redactJsonText(
  text: string,
  headerNames: readonly string[] | undefined,
): string {
  return text
    .split("\n")
    .map((line) => redactJsonLine(line, headerNames))
    .join("\n");
}

function redactJsonLine(
  line: string,
  headerNames: readonly string[] | undefined,
): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return line;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactJson(JSON.parse(line) as unknown, headerNames));
    } catch {
      return redactCapturedText(line);
    }
  }
  return redactCapturedText(line);
}

function redactJson(
  value: unknown,
  headerNames: readonly string[] | undefined,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item, headerNames));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "headers" && isNameValueList(child)) {
      result[key] = redactNameValueList(child, headerNames);
      continue;
    }
    if (key === "cookies" && Array.isArray(child)) {
      result[key] = redactCookieList(child);
      continue;
    }
    if (key === "storageState" && typeof child === "string") {
      result[key] = redactCookies(child);
      continue;
    }
    if (key === "body" && typeof child === "string") {
      result[key] = redactCapturedText(child);
      continue;
    }
    if (key === "postData" && isPlainObject(child)) {
      result[key] = redactTextChild(child, "text", headerNames);
      continue;
    }
    if (key === "content" && isPlainObject(child)) {
      result[key] = redactTextChild(child, "text", headerNames);
      continue;
    }
    result[key] = redactJson(child, headerNames);
  }
  return result;
}

function redactTextChild(
  value: Record<string, unknown>,
  textKey: string,
  headerNames: readonly string[] | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === textKey && typeof child === "string") {
      result[key] = redactCapturedText(child);
      continue;
    }
    result[key] = redactJson(child, headerNames);
  }
  return result;
}

function redactNameValueList(
  headers: readonly NameValue[],
  headerNames: readonly string[] | undefined,
): NameValue[] {
  const groups = new Map<string, { name: string; values: string[] }>();
  const order: string[] = [];
  for (const header of headers) {
    const key = header.name.toLowerCase();
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { name: header.name, values: [header.value] });
      order.push(key);
      continue;
    }
    group.values.push(header.value);
  }

  const record: Record<string, string | string[]> = {};
  for (const key of order) {
    const group = groups.get(key);
    if (group === undefined) {
      continue;
    }
    const single = group.values[0];
    record[group.name] =
      group.values.length === 1 && single !== undefined
        ? single
        : [...group.values];
  }

  const redacted =
    headerNames === undefined
      ? redactHeaders(record)
      : redactHeaders(record, headerNames);
  const result: NameValue[] = [];
  for (const key of order) {
    const group = groups.get(key);
    if (group === undefined) {
      continue;
    }
    const value = redacted[group.name];
    if (typeof value === "string") {
      result.push({ name: group.name, value });
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        result.push({ name: group.name, value: item });
      }
    }
  }
  return result;
}

function redactCookieList(cookies: readonly unknown[]): unknown[] {
  const redacted = redactCookies(JSON.stringify({ cookies }));
  try {
    const parsed: unknown = JSON.parse(redacted);
    if (isPlainObject(parsed) && Array.isArray(parsed.cookies)) {
      return parsed.cookies;
    }
  } catch {
    // Storage-state redaction did not return JSON. Wipe values below.
  }
  return cookies.map((cookie) => {
    if (!isPlainObject(cookie) || !("value" in cookie)) {
      return cookie;
    }
    return { ...cookie, value: "[redacted]" };
  });
}

function isNameValueList(value: unknown): value is NameValue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isPlainObject(item) &&
        typeof item.name === "string" &&
        typeof item.value === "string",
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "wasm",
  "pdf",
  "mp4",
  "webm",
  "mp3",
  "zip",
  "gz",
]);

/**
 * A NUL scan misses binary resources whose first bytes are not zero.
 * Decoding those as UTF-8 replaces invalid sequences and corrupts the entry.
 * Known binary extensions and any byte sequence that is not UTF-8 stay as-is.
 */
function isBinaryPayload(name: string, data: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(extensionOf(name))) {
    return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return false;
  } catch {
    return true;
  }
}

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return base.slice(dot + 1).toLowerCase();
}

function replaceFile(filePath: string, bytes: Buffer): void {
  const temporary = `${filePath}.tmp`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, filePath);
  } catch (error) {
    removeRegularFile(temporary);
    throw error;
  }
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) {
    throw new Error("Trace zip is too small");
  }
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (directoryOffset === ZIP64_MARKER) {
    throw new Error("ZIP64 traces are not rewritten");
  }

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE
    ) {
      throw new Error("Trace zip central directory is truncated");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localOffset === ZIP64_MARKER
    ) {
      throw new Error("ZIP64 traces are not rewritten");
    }
    const nameStart = offset + 46;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    entries.push({
      name,
      data: readLocalEntry(
        buffer,
        localOffset,
        method,
        compressedSize,
        uncompressedSize,
      ),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) {
      return offset;
    }
  }
  throw new Error("Trace zip is missing an end of central directory");
}

function readLocalEntry(
  buffer: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Buffer {
  if (
    localOffset + 30 > buffer.length ||
    buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
  ) {
    throw new Error("Trace zip local header is missing");
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (end > buffer.length) {
    throw new Error("Trace zip entry is truncated");
  }
  if (compressedSize === 0) {
    return Buffer.alloc(0);
  }
  const compressed = buffer.subarray(start, end);
  if (method === 0) {
    return Buffer.from(compressed);
  }
  if (method === 8) {
    const inflated = inflateRawSync(compressed);
    if (inflated.length !== uncompressedSize) {
      throw new Error("Trace zip entry inflated to an unexpected size");
    }
    return inflated;
  }
  throw new Error(`Trace zip compression method ${method} is unsupported`);
}

function writeZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) {
    throw new Error("Trace zip has too many entries");
  }
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const store = compressed.length >= entry.data.length;
    const payload = store ? entry.data : compressed;
    const method = store ? 0 : 8;
    const checksum = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function zipRoundTripMatches(
  bytes: Buffer,
  entries: readonly ZipEntry[],
): boolean {
  const readBack = readZipEntries(bytes);
  if (readBack.length !== entries.length) {
    return false;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const expected = entries[index];
    const actual = readBack[index];
    if (
      expected === undefined ||
      actual === undefined ||
      expected.name !== actual.name ||
      !expected.data.equals(actual.data)
    ) {
      return false;
    }
  }
  return true;
}
