import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { BrowserContext } from "playwright";
import { afterEach, expect, test } from "vitest";
import { startTrace, stopTrace } from "../../../src/evidence/traces.js";

const COOKIE_SECRET = "trace-cookie-secret-9f3a";
const SET_COOKIE_SECRET = "trace-set-cookie-secret-9f3a";
const AUTH_SECRET = "trace-auth-secret-9f3a";
const CUSTOM_SECRET = "trace-custom-secret-9f3a";
const ACCEPT_MARKER = "keep-me-accept-9f3a";
/** Invalid UTF-8 and no NUL, so a null-byte scan would rewrite it as text. */
const BINARY_RESOURCE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8,
]);

const secrets = [COOKIE_SECRET, SET_COOKIE_SECRET, AUTH_SECRET];

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

test("a saved trace.zip omits cookie, authorization, and configured header secrets", async () => {
  const planted = requestTraceZip();
  const before = zipBytes(planted);
  for (const secret of [...secrets, CUSTOM_SECRET]) {
    expect(before.includes(Buffer.from(secret))).toBe(true);
  }
  expect(BINARY_RESOURCE.includes(0)).toBe(false);
  expect(before.includes(BINARY_RESOURCE)).toBe(true);

  const saved = await saveTrace(planted, [
    "authorization",
    "cookie",
    "set-cookie",
    "x-secret-token",
  ]);
  const zip = readFileSync(saved);
  expect(zip.subarray(0, 2).toString("utf8")).toBe("PK");
  for (const secret of [...secrets, CUSTOM_SECRET]) {
    expect(zip.includes(Buffer.from(secret))).toBe(false);
  }

  const text = zipBytes(saved);
  for (const secret of [...secrets, CUSTOM_SECRET]) {
    expect(text.includes(Buffer.from(secret))).toBe(false);
  }
  expect(text.includes(Buffer.from(ACCEPT_MARKER))).toBe(true);
  expect(text.includes(Buffer.from("[redacted]"))).toBe(true);
  expect(text.includes(Buffer.from("session"))).toBe(true);
  expect(text.includes(Buffer.from("<h1>kept</h1>"))).toBe(true);
  expect(text.includes(Buffer.from("screencast/frame.jpeg"))).toBe(true);
  expect(text.includes(BINARY_RESOURCE)).toBe(true);
});

test("default header redaction keeps an unconfigured header value", async () => {
  const saved = await saveTrace(requestTraceZip());
  const text = zipBytes(saved);
  for (const secret of secrets) {
    expect(text.includes(Buffer.from(secret))).toBe(false);
  }
  expect(text.includes(Buffer.from(CUSTOM_SECRET))).toBe(true);
  expect(text.includes(Buffer.from(ACCEPT_MARKER))).toBe(true);
});

test("passed runs and trace mode off leave no zip", async () => {
  const dest = makeDest();
  const stopped: Array<string | undefined> = [];
  const context = contextThatStops((path) => {
    stopped.push(path);
    if (path !== undefined) {
      writeFileSync(path, Buffer.from("PK raw secret"));
    }
  });

  await startTrace(context);
  await expect(stopTrace(context, { failed: false, dest })).resolves.toBeUndefined();
  expect(existsSync(join(dest, "trace.zip"))).toBe(false);

  await startTrace(context);
  await expect(
    stopTrace(context, { failed: true, dest, mode: "off" }),
  ).resolves.toBeUndefined();
  expect(existsSync(join(dest, "trace.zip"))).toBe(false);
  expect(stopped).toEqual([undefined, undefined]);
});

async function saveTrace(
  zip: Buffer,
  redactHeaderNames?: readonly string[],
): Promise<string> {
  const dest = makeDest();
  const context = contextThatStops((path) => {
    if (path !== undefined) {
      writeFileSync(path, zip);
    }
  });
  await startTrace(context);
  const saved = await stopTrace(context, {
    failed: true,
    dest,
    mode: "on-failure",
    ...(redactHeaderNames === undefined ? {} : { redactHeaderNames }),
  });
  expect(saved).toBe(join(dest, "trace.zip"));
  return saved ?? "";
}

function makeDest(): string {
  scratch = mkdtempSync(join(tmpdir(), "qa-trace-redact-"));
  return scratch;
}

function contextThatStops(
  onStop: (path: string | undefined) => void,
): BrowserContext {
  return {
    tracing: {
      start: async () => undefined,
      stop: async (options?: { path?: string }) => {
        onStop(options?.path);
      },
    },
  } as unknown as BrowserContext;
}

function requestTraceZip(): Buffer {
  const network = {
    type: "resource-snapshot",
    snapshot: {
      request: {
        method: "GET",
        url: "https://probe.test/secret",
        cookies: [{ name: "session", value: COOKIE_SECRET }],
        headers: [
          { name: "Accept", value: ACCEPT_MARKER },
          { name: "authorization", value: `Bearer ${AUTH_SECRET}` },
          { name: "cookie", value: `session=${COOKIE_SECRET}` },
          { name: "x-secret-token", value: CUSTOM_SECRET },
        ],
      },
      response: {
        status: 200,
        cookies: [{ name: "session", value: SET_COOKIE_SECRET }],
        headers: [
          { name: "content-type", value: "text/html" },
          {
            name: "set-cookie",
            value: `session=${SET_COOKIE_SECRET}; Path=/; HttpOnly`,
          },
          { name: "x-secret-token", value: CUSTOM_SECRET },
        ],
        content: { mimeType: "text/html", text: "<h1>kept</h1>" },
      },
    },
  };
  const trace = [
    {
      type: "context-options",
      options: {
        storageState: {
          cookies: [
            {
              name: "session",
              value: COOKIE_SECRET,
              domain: "probe.test",
              path: "/",
            },
          ],
          origins: [],
        },
      },
    },
    {
      type: "before",
      class: "Page",
      method: "setExtraHTTPHeaders",
      params: {
        headers: [
          { name: "authorization", value: `Bearer ${AUTH_SECRET}` },
          { name: "cookie", value: `session=${COOKIE_SECRET}` },
          { name: "x-secret-token", value: CUSTOM_SECRET },
        ],
      },
    },
    {
      type: "before",
      class: "Route",
      method: "fulfill",
      params: {
        status: 200,
        headers: [
          {
            name: "set-cookie",
            value: `session=${SET_COOKIE_SECRET}; Path=/; HttpOnly`,
          },
          { name: "x-secret-token", value: CUSTOM_SECRET },
          { name: "content-type", value: "text/html" },
        ],
        body: "<h1>kept</h1>",
      },
    },
  ];
  return playwrightZip([
    {
      name: "trace.network",
      data: `${JSON.stringify(network)}\n`,
    },
    {
      name: "trace.trace",
      data: `${trace.map((event) => JSON.stringify(event)).join("\n")}\n`,
    },
    {
      name: "resources/body.html",
      data: "<h1>kept</h1>",
    },
    {
      name: "resources/pixel.dat",
      data: BINARY_RESOURCE,
    },
    {
      name: "screencast/frame.jpeg",
      data: Buffer.from([0x00, 0xff, 0xd8, 0x00]),
    },
  ]);
}

function playwrightZip(
  files: { name: string; data: string | Buffer }[],
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.isBuffer(file.data)
      ? file.data
      : Buffer.from(file.data, "utf8");
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(data);
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(data.length, 12);
    locals.push(local, name, compressed, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x808, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length + 16;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function zipBytes(zip: string | Buffer): Buffer {
  if (typeof zip === "string") {
    return unzip(zip);
  }
  const dir = mkdtempSync(join(tmpdir(), "qa-trace-read-"));
  const file = join(dir, "trace.zip");
  try {
    writeFileSync(file, zip);
    return unzip(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function unzip(filePath: string): Buffer {
  return execFileSync("python3", ["-c", PYTHON_UNZIP, filePath]);
}

const PYTHON_UNZIP = `
import sys
import zipfile
archive = zipfile.ZipFile(sys.argv[1])
for info in archive.infolist():
    sys.stdout.buffer.write(info.filename.encode())
    sys.stdout.buffer.write(b"\\n")
    sys.stdout.buffer.write(archive.read(info.filename))
    sys.stdout.buffer.write(b"\\n")
`;
