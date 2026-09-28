import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import { createBodyMeter, readCappedBody } from "../../../src/evidence/network.js";

const URL = "https://qa-agent.test/body";

test("a text body with no content-length above the cap is not read", async () => {
  const meter = createBodyMeter();
  const reservation = meter.reserve(URL, "GET");
  meter.noteRequest("req-1", URL, "GET");
  meter.noteData("req-1", 40);
  meter.noteData("req-1", 40);
  meter.noteFinished("req-1");

  let reads = 0;
  const captured = await readCappedBody({
    cap: 64,
    contentType: "text/plain",
    advertisedLength: undefined,
    measuredBytes: await reservation.bytes(),
    readBody: async () => {
      reads += 1;
      return Buffer.alloc(80);
    },
  });

  expect(reads).toBe(0);
  expect(captured).toEqual({ bodyOmitted: true });
  expect("body" in captured).toBe(false);
});

test("an understated content-length does not read a body over the cap", async () => {
  const meter = createBodyMeter();
  meter.noteRequest("req-1", URL, "GET");
  meter.noteData("req-1", 8);
  meter.noteData("req-1", 192);
  meter.noteFinished("req-1");

  let reads = 0;
  const captured = await readCappedBody({
    cap: 64,
    contentType: "application/json",
    advertisedLength: 8,
    measuredBytes: await meter.reserve(URL, "get").bytes(),
    readBody: async () => {
      reads += 1;
      return Buffer.alloc(200);
    },
  });

  expect(reads).toBe(0);
  expect(captured).toEqual({ bodyOmitted: true });
});

test("a json body within the cap is stored and redacted", async () => {
  const secret = "json-password-secret-9f3a";
  const raw = JSON.stringify({ password: secret, ok: true });
  const meter = createBodyMeter();
  meter.noteRequest("req-1", URL, "GET");
  meter.noteData("req-1", Buffer.byteLength(raw));
  meter.noteFinished("req-1");

  const captured = await readCappedBody({
    cap: 1024,
    contentType: "application/json; charset=utf-8",
    advertisedLength: undefined,
    measuredBytes: await meter.reserve(URL, "GET").bytes(),
    readBody: async () => Buffer.from(raw),
  });

  if (!("body" in captured)) {
    throw new Error("expected a stored body");
  }
  expect(captured.body).toContain("[redacted]");
  expect(captured.body).toContain("ok");
  expect(captured.body).not.toContain(secret);
  expect(captured).not.toHaveProperty("bodyOmitted");
});
