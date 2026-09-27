import type {
  CDPSession,
  ConsoleMessage,
  Frame,
  Page,
  Request,
  Response,
} from "playwright";

export const BROWSER_EVENT_TYPES = [
  "request",
  "response",
  "requestfailed",
  "console",
  "pageerror",
  "framenavigated",
  "runtime",
] as const;

export type BrowserEventType = (typeof BROWSER_EVENT_TYPES)[number];

/**
 * Facts copied off Playwright objects. Response bodies are never read.
 * `headers` is present only on `response` events, as a plain record.
 */
export type BrowserEvent = {
  type: BrowserEventType;
  timestamp: string;
  url?: string;
  method?: string;
  status?: number;
  resourceType?: string;
  consoleType?: string;
  text?: string;
  errorMessage?: string;
  headers?: Record<string, string>;
};

export type PageEventListener = (event: BrowserEvent) => void;

type ObservedRequest = {
  url: string;
  method: string;
  resourceType: string;
};

type DataRequestEvent = {
  requestId: string;
  type?: string;
  request: {
    url: string;
    method: string;
  };
};

type DataResponseEvent = {
  requestId: string;
  type?: string;
  response: {
    url: string;
    status: number;
    headers?: Record<string, string>;
  };
};

type DataFailureEvent = {
  requestId: string;
  errorText: string;
};

const CDP_RESOURCE_TYPES: Record<string, string> = {
  Document: "document",
  Stylesheet: "stylesheet",
  Image: "image",
  Media: "media",
  Font: "font",
  Script: "script",
  TextTrack: "texttrack",
  XHR: "xhr",
  Fetch: "fetch",
  EventSource: "eventsource",
  WebSocket: "websocket",
  Manifest: "manifest",
  Other: "other",
};

/**
 * Registers Playwright listeners for one page and returns `detach`.
 * Await this before navigating so data-URL observation is armed.
 *
 * Playwright drops `data:` URLs before they become `request` events.
 * A page CDP session reports only that traffic. Response bodies are not read.
 * This function does not write files.
 *
 * A listener exception is caught and emitted as a `runtime` event.
 * It is not thrown into the page.
 */
export async function attachPageEvents(
  page: Page,
  listener: PageEventListener,
): Promise<() => void> {
  let detached = false;
  let playwrightEmitsDataRequests = false;
  const dataRequests = new Map<string, ObservedRequest>();

  const deliver = (event: BrowserEvent): void => {
    if (detached) {
      return;
    }
    try {
      listener(event);
    } catch (error) {
      if (event.type === "runtime") {
        return;
      }
      try {
        listener({
          type: "runtime",
          timestamp: timestamp(),
          errorMessage: readErrorMessage(error),
        });
      } catch {
        // The listener must not throw into the page.
      }
    }
  };

  const onRequest = (request: Request): void => {
    const url = request.url();
    if (url.startsWith("data:")) {
      playwrightEmitsDataRequests = true;
    }
    deliver({
      type: "request",
      timestamp: timestamp(),
      url,
      method: request.method(),
      resourceType: request.resourceType(),
    });
  };

  const onResponse = (response: Response): void => {
    const request = response.request();
    deliver({
      type: "response",
      timestamp: timestamp(),
      url: response.url(),
      method: request.method(),
      status: response.status(),
      resourceType: request.resourceType(),
      headers: plainHeaders(response.headers()),
    });
  };

  const onRequestFailed = (request: Request): void => {
    deliver({
      type: "requestfailed",
      timestamp: timestamp(),
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      errorMessage: request.failure()?.errorText ?? "",
    });
  };

  const onConsole = (message: ConsoleMessage): void => {
    const url = message.location().url;
    deliver({
      type: "console",
      timestamp: timestamp(),
      consoleType: message.type(),
      text: message.text(),
      ...(url.length > 0 ? { url } : {}),
    });
  };

  const onPageError = (error: Error): void => {
    const url = page.url();
    deliver({
      type: "pageerror",
      timestamp: timestamp(),
      errorMessage: error.message,
      ...(url.length > 0 ? { url } : {}),
    });
  };

  const onFrameNavigated = (frame: Frame): void => {
    deliver({
      type: "framenavigated",
      timestamp: timestamp(),
      url: frame.url(),
    });
  };

  const onDataRequest = (event: DataRequestEvent): void => {
    const url = event.request.url;
    if (!url.startsWith("data:") || playwrightEmitsDataRequests) {
      return;
    }
    if (dataRequests.has(event.requestId)) {
      return;
    }
    const observed = {
      url,
      method: event.request.method,
      resourceType: resourceTypeFromCdp(event.type),
    };
    dataRequests.set(event.requestId, observed);
    deliver({
      type: "request",
      timestamp: timestamp(),
      url: observed.url,
      method: observed.method,
      resourceType: observed.resourceType,
    });
  };

  const onDataResponse = (event: DataResponseEvent): void => {
    const url = event.response.url;
    if (!url.startsWith("data:") || playwrightEmitsDataRequests) {
      return;
    }
    const observed = dataRequests.get(event.requestId);
    dataRequests.delete(event.requestId);
    deliver({
      type: "response",
      timestamp: timestamp(),
      url,
      method: observed?.method,
      status: event.response.status,
      resourceType: observed?.resourceType ?? resourceTypeFromCdp(event.type),
      headers: plainHeaders(event.response.headers ?? {}),
    });
  };

  const onDataFailed = (event: DataFailureEvent): void => {
    const observed = dataRequests.get(event.requestId);
    if (observed === undefined || playwrightEmitsDataRequests) {
      return;
    }
    dataRequests.delete(event.requestId);
    deliver({
      type: "requestfailed",
      timestamp: timestamp(),
      url: observed.url,
      method: observed.method,
      resourceType: observed.resourceType,
      errorMessage: event.errorText,
    });
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("framenavigated", onFrameNavigated);

  let session: CDPSession | undefined;
  const detach = (): void => {
    if (detached) {
      return;
    }
    detached = true;
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("framenavigated", onFrameNavigated);
    if (session === undefined) {
      return;
    }
    session.off("Network.requestWillBeSent", onDataRequest);
    session.off("Network.responseReceived", onDataResponse);
    session.off("Network.loadingFailed", onDataFailed);
    void session.detach().catch(() => {
      // The page may already be closed.
    });
  };

  try {
    session = await page.context().newCDPSession(page);
    if (detached) {
      await session.detach().catch(() => {
        // detach() already ran while the session was opening.
      });
      return detach;
    }
    await session.send("Network.enable");
    if (detached) {
      await session.detach().catch(() => {
        // detach() already ran while Network.enable was in flight.
      });
      return detach;
    }
    session.on("Network.requestWillBeSent", onDataRequest);
    session.on("Network.responseReceived", onDataResponse);
    session.on("Network.loadingFailed", onDataFailed);
  } catch (error) {
    detach();
    throw error;
  }

  return detach;
}

function timestamp(): string {
  return new Date().toISOString();
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown listener failure";
}

function plainHeaders(headers: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    copy[name] = value;
  }
  return copy;
}

function resourceTypeFromCdp(type: string | undefined): string {
  if (type === undefined || type.length === 0) {
    return "other";
  }
  return CDP_RESOURCE_TYPES[type] ?? type.toLowerCase();
}
