import type { Page, Request, Response } from "playwright";
import {
  attachPageEvents,
  type BrowserEvent,
} from "../playwright/events.js";
import { redactBody, redactHeaders } from "../security/redaction.js";
import {
  createCapture,
  recordConsoleMessage,
  recordPageError,
  type EvidenceCapture,
} from "./console.js";
import type { NetworkFailure, NetworkRecord } from "./types.js";

export type { EvidenceCapture } from "./console.js";

export type CaptureOptions = {
  evidence: {
    network: boolean;
    console: boolean;
    maxResponseBodyBytes: number;
  };
  /** Defaults to authorization, cookie, and set-cookie. */
  redactHeaderNames?: readonly string[];
};

export type CaptureSession = {
  capture: EvidenceCapture;
  /** Detaches listeners and waits for in-flight body reads. */
  stop: () => Promise<void>;
};

type RecordBase = {
  method: string;
  url: string;
  status: number;
  timing: number;
  headers: Record<string, string>;
};

/**
 * Subscribes to page facts and, when network capture is on, reads response
 * bodies from the Playwright `Response`. The event emitter does not include
 * bodies. Call {@link CaptureSession.stop} before reading stored bodies.
 */
export async function startCapture(
  page: Page,
  options: CaptureOptions,
): Promise<CaptureSession> {
  const capture = createCapture();
  const meter = createBodyMeter();
  const responses: Response[] = [];
  const failures: Request[] = [];
  const pending: Promise<void>[] = [];
  let stopped = false;
  let releaseMeter: () => void = () => {};

  const stashResponse = (response: Response): void => {
    if (!stopped) {
      responses.push(response);
    }
  };
  const stashFailure = (request: Request): void => {
    if (!stopped) {
      failures.push(request);
    }
  };

  // Queued before attachPageEvents delivers the matching event. Listener
  // order is registration order, and the emitter does not carry the body.
  if (options.evidence.network) {
    page.on("response", stashResponse);
    page.on("requestfailed", stashFailure);
  }

  const onEvent = (event: BrowserEvent): void => {
    if (stopped) {
      return;
    }
    if (event.type === "response") {
      if (!options.evidence.network) {
        return;
      }
      const response = responses.shift();
      track(pending, recordResponse(capture, event, response, options, meter));
      return;
    }
    if (event.type === "requestfailed") {
      if (!options.evidence.network) {
        return;
      }
      const request = failures.shift();
      track(pending, recordFailure(capture, event, request, options));
      return;
    }
    if (event.type === "console") {
      recordConsoleMessage(
        capture,
        { type: event.consoleType, text: event.text, url: event.url },
        {
          enabled: options.evidence.console,
          maxBytes: options.evidence.maxResponseBodyBytes,
        },
      );
      return;
    }
    if (event.type === "pageerror") {
      recordPageError(
        capture,
        { message: event.errorMessage, url: event.url },
        options.evidence.maxResponseBodyBytes,
      );
    }
  };

  let detachEvents: () => void;
  try {
    if (options.evidence.network) {
      releaseMeter = await attachDecodedSizeMeter(page, meter);
    }
    detachEvents = await attachPageEvents(page, onEvent);
  } catch (error) {
    meter.close();
    releaseMeter();
    page.off("response", stashResponse);
    page.off("requestfailed", stashFailure);
    throw error;
  }

  const stop = async (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      detachEvents();
      page.off("response", stashResponse);
      page.off("requestfailed", stashFailure);
      responses.length = 0;
      failures.length = 0;
      // Unblock an in-flight size wait before flushing it. Otherwise stop
      // would wait on the read, and the read would wait on stop.
      meter.close();
    }
    await flush(pending);
    releaseMeter();
  };

  return { capture, stop };
}

function track(pending: Promise<void>[], promise: Promise<void>): void {
  pending.push(promise);
  const remove = (): void => {
    const index = pending.indexOf(promise);
    if (index >= 0) {
      pending.splice(index, 1);
    }
  };
  promise.then(remove, remove);
}

async function flush(pending: Promise<void>[]): Promise<void> {
  while (pending.length > 0) {
    const batch = pending.splice(0, pending.length);
    await Promise.all(batch);
  }
}

async function recordResponse(
  capture: EvidenceCapture,
  event: BrowserEvent,
  response: Response | undefined,
  options: CaptureOptions,
  meter: BodyMeter,
): Promise<void> {
  try {
    capture.network.responses.push(
      await buildResponse(event, response, options, meter),
    );
  } catch {
    capture.network.responses.push(eventResponse(event, options));
  }
}

async function recordFailure(
  capture: EvidenceCapture,
  event: BrowserEvent,
  request: Request | undefined,
  options: CaptureOptions,
): Promise<void> {
  try {
    capture.network.failedRequests.push(
      await buildFailure(event, request, options),
    );
  } catch {
    capture.network.failedRequests.push(
      failureFromEvent(event, options.evidence.maxResponseBodyBytes),
    );
  }
}

async function buildResponse(
  event: BrowserEvent,
  response: Response | undefined,
  options: CaptureOptions,
  meter: BodyMeter,
): Promise<NetworkRecord> {
  if (response === undefined) {
    return eventResponse(event, options);
  }

  const cap = options.evidence.maxResponseBodyBytes;
  const request = response.request();
  // Claim the size slot before the first await so concurrent responses keep
  // header order. The read itself waits until those bytes have arrived.
  const reservation = meter.reserve(
    response.url() || event.url || "",
    request.method() || event.method || "GET",
  );
  const [requestHeaders, responseHeaders] = await Promise.all([
    readHeaders(
      () => request.allHeaders(),
      () => request.headers(),
    ),
    readHeaders(
      () => response.allHeaders(),
      () => response.headers(),
    ),
  ]);
  const base: RecordBase = {
    method: request.method() || event.method || "GET",
    url: response.url() || event.url || "",
    status: response.status(),
    timing: elapsedMs(request),
    headers: redactHeaderMap(
      { ...requestHeaders, ...responseHeaders },
      options.redactHeaderNames,
    ),
  };
  const contentType =
    headerValue(responseHeaders, "content-type") ??
    headerValue(response.headers(), "content-type");
  const advertised = advertisedLength(headerValue(responseHeaders, "content-length"));
  if (!isJsonOrText(contentType) || (advertised !== undefined && advertised > cap)) {
    return withoutBody(base);
  }

  try {
    await response.finished();
  } catch {
    return withoutBody(base);
  }

  // response.body() buffers the decoded payload. Content-Length is absent for
  // chunked responses and can be smaller than that payload, so the received
  // byte count has to win before the read.
  const measured = await reservation.bytes();
  const captured = await readCappedBody({
    cap,
    contentType,
    advertisedLength: advertised,
    measuredBytes: measured,
    readBody: () => response.body(),
  });
  if ("body" in captured) {
    return withBody(base, captured.body);
  }
  return withoutBody(base);
}

async function buildFailure(
  event: BrowserEvent,
  request: Request | undefined,
  options: CaptureOptions,
): Promise<NetworkFailure> {
  const cap = options.evidence.maxResponseBodyBytes;
  const errorText = event.errorMessage ?? request?.failure()?.errorText ?? "";
  if (request === undefined) {
    return failureFromEvent(event, cap);
  }
  const headers = await readHeaders(
    () => request.allHeaders(),
    () => request.headers(),
  );
  return {
    method: request.method() || event.method || "GET",
    url: request.url() || event.url || "",
    status: 0,
    timing: elapsedMs(request),
    headers: redactHeaderMap(headers, options.redactHeaderNames),
    body: redactBody(errorText, cap),
  };
}

function eventResponse(event: BrowserEvent, options: CaptureOptions): NetworkRecord {
  return withoutBody({
    method: event.method ?? "GET",
    url: event.url ?? "",
    status: event.status ?? 0,
    timing: 0,
    headers: redactHeaderMap(event.headers ?? {}, options.redactHeaderNames),
  });
}

function failureFromEvent(event: BrowserEvent, maxBytes: number): NetworkFailure {
  return {
    method: event.method ?? "GET",
    url: event.url ?? "",
    status: 0,
    timing: 0,
    headers: {},
    body: redactBody(event.errorMessage ?? "", maxBytes),
  };
}

function withBody(base: RecordBase, body: string): NetworkRecord {
  return { ...base, body };
}

function withoutBody(base: RecordBase): NetworkRecord {
  return { ...base, bodyOmitted: true };
}

async function readHeaders(
  readAll: () => Promise<Record<string, string>>,
  readBasic: () => Record<string, string>,
): Promise<Record<string, string>> {
  try {
    return await readAll();
  } catch {
    try {
      return readBasic();
    } catch {
      return {};
    }
  }
}

function redactHeaderMap(
  headers: Readonly<Record<string, string>>,
  names: readonly string[] | undefined,
): Record<string, string> {
  const redacted =
    names === undefined ? redactHeaders(headers) : redactHeaders(headers, names);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(redacted)) {
    result[name] = typeof value === "string" ? value : value.join("\n");
  }
  return result;
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function advertisedLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function isJsonOrText(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType.startsWith("text/")) {
    return true;
  }
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export type CappedBodyRead = {
  cap: number;
  contentType: string | undefined;
  advertisedLength: number | undefined;
  /** Decoded bytes already received. Unknown sizes are not read. */
  measuredBytes: number | undefined;
  readBody: () => Promise<Buffer>;
};

/**
 * Reads a text or JSON body only when its size is known and within the cap.
 * `readBody` is not called for an oversized payload, including when
 * Content-Length is missing or smaller than the measured bytes.
 */
export async function readCappedBody(
  input: CappedBodyRead,
): Promise<{ body: string } | { bodyOmitted: true }> {
  if (!isJsonOrText(input.contentType)) {
    return { bodyOmitted: true };
  }
  if (input.advertisedLength !== undefined && input.advertisedLength > input.cap) {
    return { bodyOmitted: true };
  }
  if (input.measuredBytes === undefined || input.measuredBytes > input.cap) {
    return { bodyOmitted: true };
  }

  try {
    const bytes = await input.readBody();
    if (bytes.length > input.cap) {
      return { bodyOmitted: true };
    }
    return { body: redactBody(bytes.toString("utf8"), input.cap) };
  } catch {
    return { bodyOmitted: true };
  }
}

type MeterEntry = {
  url: string;
  method: string;
  decoded: number;
  claimed: boolean;
  done: boolean;
  aborted: boolean;
  finish: () => void;
  finished: Promise<void>;
};

type MeterWaiter = {
  url: string;
  method: string;
  resolve: (entry: MeterEntry | undefined) => void;
};

export type BodyReservation = {
  /** Resolves with the decoded size after the response finishes loading. */
  bytes: () => Promise<number | undefined>;
};

export type BodyMeter = {
  noteRequest: (requestId: string, url: string, method: string) => void;
  noteData: (requestId: string, byteLength: number) => void;
  noteFinished: (requestId: string) => void;
  reserve: (url: string, method: string) => BodyReservation;
  close: () => void;
};

/**
 * Counts decoded response bytes from CDP data lengths. Chunk payloads are
 * not retained, so an oversized body never becomes one buffer here.
 */
export function createBodyMeter(): BodyMeter {
  const byId = new Map<string, MeterEntry>();
  const pending = new MeterWaiterQueue();
  const finishedEarly = new Set<string>();
  let closed = false;

  const noteRequest = (requestId: string, url: string, method: string): void => {
    if (closed) {
      return;
    }
    const entry = entryFor(byId, requestId);
    if (!entry.claimed) {
      entry.url = url;
      entry.method = method.toUpperCase();
    }
    if (finishedEarly.delete(requestId)) {
      markDone(entry, false);
    }
    pending.match(entry);
  };

  const noteData = (requestId: string, byteLength: number): void => {
    if (closed || !Number.isFinite(byteLength) || byteLength <= 0) {
      return;
    }
    const entry = entryFor(byId, requestId);
    // The reservation claims this entry when headers arrive, which is before
    // the body chunks. Keep counting until the load finishes.
    if (entry.done) {
      return;
    }
    const next = entry.decoded + byteLength;
    entry.decoded = next > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : next;
  };

  const noteFinished = (requestId: string): void => {
    if (closed) {
      return;
    }
    const entry = byId.get(requestId);
    if (entry === undefined) {
      finishedEarly.add(requestId);
      return;
    }
    markDone(entry, false);
  };

  const reserve = (url: string, method: string): BodyReservation => {
    const normalized = method.toUpperCase();
    if (closed) {
      return { bytes: async () => undefined };
    }
    const existing = unclaimed(byId, url, normalized);
    if (existing !== undefined) {
      existing.claimed = true;
      return { bytes: () => bytesOf(existing) };
    }
    let resolveEntry: (entry: MeterEntry | undefined) => void = () => {};
    const entryPromise = new Promise<MeterEntry | undefined>((resolve) => {
      resolveEntry = resolve;
    });
    pending.add({ url, method: normalized, resolve: resolveEntry });
    return {
      bytes: async () => bytesOf(await entryPromise),
    };
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    pending.rejectAll();
    for (const entry of byId.values()) {
      markDone(entry, !entry.done);
    }
    byId.clear();
    finishedEarly.clear();
  };

  return { noteRequest, noteData, noteFinished, reserve, close };
}

function entryFor(byId: Map<string, MeterEntry>, requestId: string): MeterEntry {
  const existing = byId.get(requestId);
  if (existing !== undefined) {
    return existing;
  }
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entry: MeterEntry = {
    url: "",
    method: "",
    decoded: 0,
    claimed: false,
    done: false,
    aborted: false,
    finish,
    finished,
  };
  byId.set(requestId, entry);
  return entry;
}

function markDone(entry: MeterEntry, aborted: boolean): void {
  if (entry.done) {
    return;
  }
  entry.aborted = aborted;
  entry.done = true;
  entry.finish();
}

function unclaimed(
  byId: Map<string, MeterEntry>,
  url: string,
  method: string,
): MeterEntry | undefined {
  for (const entry of byId.values()) {
    if (!entry.claimed && entry.url === url && entry.method === method) {
      return entry;
    }
  }
  return undefined;
}

async function bytesOf(entry: MeterEntry | undefined): Promise<number | undefined> {
  if (entry === undefined) {
    return undefined;
  }
  if (!entry.done) {
    await entry.finished;
  }
  if (entry.aborted) {
    return undefined;
  }
  return entry.decoded;
}

class MeterWaiterQueue {
  private readonly waiters: MeterWaiter[] = [];

  add(waiter: MeterWaiter): void {
    this.waiters.push(waiter);
  }

  match(entry: MeterEntry): void {
    if (entry.claimed || entry.url.length === 0) {
      return;
    }
    const index = this.waiters.findIndex(
      (waiter) => waiter.url === entry.url && waiter.method === entry.method,
    );
    if (index < 0) {
      return;
    }
    const waiter = this.waiters[index];
    if (waiter === undefined) {
      return;
    }
    this.waiters.splice(index, 1);
    entry.claimed = true;
    waiter.resolve(entry);
  }

  rejectAll(): void {
    const waiting = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiting) {
      waiter.resolve(undefined);
    }
  }
}

async function attachDecodedSizeMeter(
  page: Page,
  meter: BodyMeter,
): Promise<() => void> {
  const session = await page.context().newCDPSession(page);
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    session.off("Network.requestWillBeSent", onRequest);
    session.off("Network.dataReceived", onData);
    session.off("Network.loadingFinished", onFinished);
    session.off("Network.loadingFailed", onFinished);
    void session.detach().catch(() => {
      // The page may already be closed.
    });
  };

  const onRequest = (event: {
    requestId: string;
    request: { url: string; method: string };
  }): void => {
    meter.noteRequest(event.requestId, event.request.url, event.request.method);
  };
  const onData = (event: { requestId: string; dataLength: number }): void => {
    meter.noteData(event.requestId, event.dataLength);
  };
  const onFinished = (event: { requestId: string }): void => {
    meter.noteFinished(event.requestId);
  };

  session.on("Network.requestWillBeSent", onRequest);
  session.on("Network.dataReceived", onData);
  session.on("Network.loadingFinished", onFinished);
  session.on("Network.loadingFailed", onFinished);
  try {
    await session.send("Network.enable");
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

function elapsedMs(request: Request): number {
  try {
    const timing = request.timing();
    if (timing.responseEnd >= 0) {
      return Math.round(timing.responseEnd);
    }
    if (timing.responseStart >= 0) {
      return Math.round(timing.responseStart);
    }
  } catch {
    return 0;
  }
  return 0;
}
