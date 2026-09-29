import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import { createBodyMeter, readCappedBody } from "../../../src/evidence/network.js";

const URL = "https://qa-agent.test/body";

test("a text body with no content-length above the cap is not read", async () => {
  const meter = createBodyMeter();
  const reservation = meter.reserve("pw-1");
  meter.noteRequest("req-1", URL, "GET");
  meter.bind("pw-1");
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
  meter.bind("pw-1");
  meter.noteData("req-1", 8);
  meter.noteData("req-1", 192);
  meter.noteFinished("req-1");

  let reads = 0;
  const captured = await readCappedBody({
    cap: 64,
    contentType: "application/json",
    advertisedLength: 8,
    measuredBytes: await meter.reserve("pw-1").bytes(),
    readBody: async () => {
      reads += 1;
      return Buffer.alloc(200);
    },
  });

  expect(reads).toBe(0);
  expect(captured).toEqual({ bodyOmitted: true });
});

test("a finished hop with no data length does not read the body", async () => {
  const meter = createBodyMeter();
  meter.noteRequest("req-1", URL, "GET");
  meter.bind("pw-1");
  meter.noteFinished("req-1");

  let reads = 0;
  const captured = await readCappedBody({
    cap: 64,
    contentType: "text/plain",
    advertisedLength: undefined,
    measuredBytes: await meter.reserve("pw-1").bytes(),
    readBody: async () => {
      reads += 1;
      return Buffer.alloc(80);
    },
  });

  expect(reads).toBe(0);
  expect(captured).toEqual({ bodyOmitted: true });
});

test("concurrent responses to one URL keep their own byte counts", async () => {
  const meter = createBodyMeter();
  meter.bind("pw-slow");
  meter.bind("pw-fast");
  meter.noteRequest("slow", URL, "GET");
  meter.noteRequest("fast", URL, "GET");
  meter.noteData("fast", 10);
  meter.noteFinished("fast");
  meter.noteData("slow", 500);
  meter.noteFinished("slow");

  expect(await meter.reserve("pw-fast").bytes()).toBe(10);
  expect(await meter.reserve("pw-slow").bytes()).toBe(500);
});

test("a redirect reuses the CDP request id across hops", async () => {
  const meter = createBodyMeter();
  meter.noteRequest("req-1", "https://qa-agent.test/from", "GET");
  meter.bind("hop-from");
  meter.noteRequest("req-1", "https://qa-agent.test/to", "GET");
  meter.bind("hop-to");
  meter.noteData("req-1", 500);
  meter.noteFinished("req-1");

  expect(await meter.reserve("hop-from").bytes()).toBeUndefined();
  expect(await meter.reserve("hop-to").bytes()).toBe(500);
});

test("a reserved generation is dropped once its size is known", async () => {
  const meter = createBodyMeter();
  meter.noteRequest("req-1", URL, "GET");
  meter.bind("pw-1");
  meter.noteData("req-1", 20);
  meter.noteFinished("req-1");
  expect(meter.retained()).toBe(1);

  expect(await meter.reserve("pw-1").bytes()).toBe(20);
  expect(meter.retained()).toBe(0);
});

test("a json body within the cap is stored and redacted", async () => {
  const secret = "json-password-secret-9f3a";
  const raw = JSON.stringify({ password: secret, ok: true });
  const meter = createBodyMeter();
  meter.noteRequest("req-1", URL, "GET");
  meter.bind("pw-1");
  meter.noteData("req-1", Buffer.byteLength(raw));
  meter.noteFinished("req-1");

  const captured = await readCappedBody({
    cap: 1024,
    contentType: "application/json; charset=utf-8",
    advertisedLength: undefined,
    measuredBytes: await meter.reserve("pw-1").bytes(),
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
