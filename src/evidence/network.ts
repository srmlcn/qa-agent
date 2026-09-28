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
  const requestTokens = new WeakMap<Request, string>();
  let requestSerial = 0;
  const responses: Response[] = [];
  const failures: Request[] = [];
  const pending: Promise<void>[] = [];
  let stopped = false;
  let releaseMeter: () => void = () => {};

  const requestToken = (request: Request): string => {
    const existing = requestTokens.get(request);
    if (existing !== undefined) {
      return existing;
    }
    const token = `request-${requestSerial}`;
    requestSerial += 1;
    requestTokens.set(request, token);
    return token;
  };

  const bindRequest = (request: Request): void => {
    // data: URLs are reported by the page CDP session in events.ts and do not
    // become Playwright request events. Leave them out of this pairing.
    if (!stopped && !request.url().startsWith("data:")) {
      meter.bind(requestToken(request));
    }
  };
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
    page.on("request", bindRequest);
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
      track(
        pending,
        recordResponse(capture, event, response, options, meter, requestToken),
      );
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
    page.off("request", bindRequest);
    page.off("response", stashResponse);
    page.off("requestfailed", stashFailure);
    throw error;
  }

  const stop = async (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      detachEvents();
      page.off("request", bindRequest);
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
  requestToken: (request: Request) => string,
): Promise<void> {
  try {
    capture.network.responses.push(
      await buildResponse(event, response, options, meter, requestToken),
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
  requestToken: (request: Request) => string,
): Promise<NetworkRecord> {
  if (response === undefined) {
    return eventResponse(event, options);
  }

  const cap = options.evidence.maxResponseBodyBytes;
  const request = response.request();
  // Pair with the CDP hop for this Playwright request before the first await.
  // URL and method are not an identity: concurrent calls and redirects share them.
  const reservation = meter.reserve(requestToken(request));
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

type MeterGeneration = {
  requestId: string;
  token?: string;
  decoded: number;
  /** True once a dataReceived length was applied to this hop. */
  observed: boolean;
  claimed: boolean;
  done: boolean;
  aborted: boolean;
  finish: () => void;
  finished: Promise<void>;
};

type EarlyBytes = {
  total: number;
  observed: boolean;
};

export type BodyReservation = {
  /** Resolves with the decoded size after this hop finishes loading. */
  bytes: () => Promise<number | undefined>;
};

export type BodyMeter = {
  /** One call per CDP requestWillBeSent. The same requestId starts a new redirect hop. */
  noteRequest: (requestId: string, url: string, method: string) => void;
  noteData: (requestId: string, byteLength: number) => void;
  noteFinished: (requestId: string) => void;
  /** Pairs the next CDP hop with one Playwright request, in lifecycle order. */
  bind: (token: string) => void;
  reserve: (token: string) => BodyReservation;
  /** Generations that can still be reserved or are still loading. */
  retained: () => number;
  close: () => void;
};

/**
 * Counts decoded response bytes from CDP data lengths. Chunk payloads are
 * not retained. Each redirect hop is its own generation, paired with the
 * Playwright request that belongs to that hop rather than by URL.
 */
export function createBodyMeter(): BodyMeter {
  const latest = new Map<string, MeterGeneration>();
  const byToken = new Map<string, MeterGeneration>();
  const unpairedCdp: MeterGeneration[] = [];
  const unpairedTokens: string[] = [];
  const waiters = new Map<string, Array<(entry: MeterGeneration | undefined) => void>>();
  const earlyData = new Map<string, EarlyBytes>();
  const finishedEarly = new Set<string>();
  let closed = false;

  const noteRequest = (requestId: string, url: string): void => {
    if (closed || url.startsWith("data:")) {
      return;
    }
    const previous = latest.get(requestId);
    if (previous !== undefined && !previous.done) {
      markDone(previous, false);
      compact(previous);
    }
    const generation = createGeneration(requestId);
    const early = earlyData.get(requestId);
    if (early !== undefined) {
      earlyData.delete(requestId);
      generation.decoded = early.total;
      generation.observed = early.observed;
    }
    latest.set(requestId, generation);
    if (finishedEarly.delete(requestId)) {
      markDone(generation, false);
    }
    unpairedCdp.push(generation);
    pair();
    compact(generation);
  };

  const noteData = (requestId: string, byteLength: number): void => {
    if (closed || !Number.isFinite(byteLength) || byteLength < 0) {
      return;
    }
    const generation = latest.get(requestId);
    if (generation === undefined || generation.done) {
      if (generation === undefined) {
        rememberEarly(earlyData, requestId, byteLength);
      }
      return;
    }
    generation.observed = true;
    if (byteLength > 0) {
      generation.decoded = cappedSum(generation.decoded, byteLength);
    }
  };

  const noteFinished = (requestId: string): void => {
    if (closed) {
      return;
    }
    const generation = latest.get(requestId);
    if (generation === undefined) {
      finishedEarly.add(requestId);
      return;
    }
    markDone(generation, false);
    compact(generation);
  };

  const bind = (token: string): void => {
    if (closed || token.length === 0 || byToken.has(token) || unpairedTokens.includes(token)) {
      return;
    }
    unpairedTokens.push(token);
    pair();
  };

  const reserve = (token: string): BodyReservation => {
    if (closed) {
      return { bytes: async () => undefined };
    }
    const existing = byToken.get(token);
    if (existing !== undefined) {
      claim(existing);
      return { bytes: () => bytesOf(existing) };
    }
    let resolveEntry: (entry: MeterGeneration | undefined) => void = () => {};
    const entryPromise = new Promise<MeterGeneration | undefined>((resolve) => {
      resolveEntry = resolve;
    });
    const waiting = waiters.get(token) ?? [];
    waiting.push(resolveEntry);
    waiters.set(token, waiting);
    return { bytes: async () => bytesOf(await entryPromise) };
  };

  const retained = (): number => {
    const seen = new Set<MeterGeneration>();
    for (const generation of latest.values()) {
      seen.add(generation);
    }
    for (const generation of unpairedCdp) {
      seen.add(generation);
    }
    for (const generation of byToken.values()) {
      seen.add(generation);
    }
    return seen.size;
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const waiting of waiters.values()) {
      for (const resolve of waiting) {
        resolve(undefined);
      }
    }
    waiters.clear();
    for (const generation of latest.values()) {
      markDone(generation, !generation.done);
    }
    latest.clear();
    byToken.clear();
    unpairedCdp.length = 0;
    unpairedTokens.length = 0;
    earlyData.clear();
    finishedEarly.clear();
  };

  function pair(): void {
    while (unpairedCdp.length > 0 && unpairedTokens.length > 0) {
      const generation = unpairedCdp.shift();
      const token = unpairedTokens.shift();
      if (generation === undefined || token === undefined) {
        return;
      }
      generation.token = token;
      const waiting = waiters.get(token);
      if (waiting !== undefined) {
        waiters.delete(token);
        generation.claimed = true;
        for (const resolve of waiting) {
          resolve(generation);
        }
        compact(generation);
      } else {
        byToken.set(token, generation);
      }
    }
  }

  function claim(generation: MeterGeneration): void {
    generation.claimed = true;
    if (generation.token !== undefined) {
      byToken.delete(generation.token);
    }
    compact(generation);
  }

  function compact(generation: MeterGeneration): void {
    if (!generation.claimed || !generation.done) {
      return;
    }
    if (generation.token !== undefined) {
      byToken.delete(generation.token);
    }
    if (latest.get(generation.requestId) === generation) {
      latest.delete(generation.requestId);
    }
    const index = unpairedCdp.indexOf(generation);
    if (index >= 0) {
      unpairedCdp.splice(index, 1);
    }
  }

  return { noteRequest, noteData, noteFinished, bind, reserve, retained, close };
}

function createGeneration(requestId: string): MeterGeneration {
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    requestId,
    decoded: 0,
    observed: false,
    claimed: false,
    done: false,
    aborted: false,
    finish,
    finished,
  };
}

function markDone(generation: MeterGeneration, aborted: boolean): void {
  if (generation.done) {
    return;
  }
  generation.aborted = aborted;
  generation.done = true;
  generation.finish();
}

function rememberEarly(
  earlyData: Map<string, EarlyBytes>,
  requestId: string,
  byteLength: number,
): void {
  const early = earlyData.get(requestId) ?? { total: 0, observed: false };
  early.observed = true;
  if (byteLength > 0) {
    early.total = cappedSum(early.total, byteLength);
  }
  earlyData.set(requestId, early);
}

function cappedSum(current: number, byteLength: number): number {
  const next = current + byteLength;
  return next > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : next;
}

async function bytesOf(
  entry: MeterGeneration | undefined,
): Promise<number | undefined> {
  if (entry === undefined) {
    return undefined;
  }
  if (!entry.done) {
    await entry.finished;
  }
  // A finished hop with no dataReceived event has an unknown size. Zero would
  // look like an empty body and pull response.body() for a cache hit.
  if (entry.aborted || !entry.observed) {
    return undefined;
  }
  return entry.decoded;
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
    if (event.request.url.startsWith("data:")) {
      return;
    }
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
