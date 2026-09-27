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
  const responses: Response[] = [];
  const failures: Request[] = [];
  const pending: Promise<void>[] = [];
  let stopped = false;

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
      track(pending, recordResponse(capture, event, response, options));
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
    detachEvents = await attachPageEvents(page, onEvent);
  } catch (error) {
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
    }
    await flush(pending);
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
): Promise<void> {
  try {
    capture.network.responses.push(
      await buildResponse(event, response, options),
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
): Promise<NetworkRecord> {
  if (response === undefined) {
    return eventResponse(event, options);
  }

  const cap = options.evidence.maxResponseBodyBytes;
  const request = response.request();
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
    const bytes = await response.body();
    if (bytes.length > cap) {
      return withoutBody(base);
    }
    return withBody(base, redactBody(bytes.toString("utf8"), cap));
  } catch {
    return withoutBody(base);
  }
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
