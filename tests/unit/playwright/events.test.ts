import { expect, test } from "vitest";
import type { Page, Request } from "playwright";
import {
  attachPageEvents,
  type BrowserEvent,
  type PageEventListener,
} from "../../../src/playwright/events.js";

const FALLBACK = "Unknown listener failure";

test("a thrown object with a string message keeps that message", async () => {
  await expectListenerFailure(
    { message: "listener blew up" },
    "listener blew up",
  );
  await expectListenerFailure({ message: "" }, "");
});

test("thrown strings and Error instances keep their message", async () => {
  await expectListenerFailure("listener blew up", "listener blew up");
  await expectListenerFailure(
    new Error("listener blew up"),
    "listener blew up",
  );
});

test("a thrown value with no string message uses the listener fallback", async () => {
  await expectListenerFailure({ code: "E_LISTENER" }, FALLBACK);
  await expectListenerFailure({ message: 12 }, FALLBACK);
  await expectListenerFailure(42, FALLBACK);
  await expectListenerFailure(null, FALLBACK);
});

async function expectListenerFailure(
  thrown: unknown,
  errorMessage: string,
): Promise<void> {
  const events: BrowserEvent[] = [];
  const { emit } = await attachThrowingListener((event) => {
    events.push(event);
    if (event.type !== "runtime") {
      throw thrown;
    }
  });

  emit("request", request());

  expect(events.filter((event) => event.type === "runtime")).toEqual([
    expect.objectContaining({
      type: "runtime",
      errorMessage,
    }),
  ]);
}

async function attachThrowingListener(
  listener: PageEventListener,
): Promise<{ emit: (event: string, payload: unknown) => void }> {
  const listeners = new Map<string, (payload: unknown) => void>();
  const page = {
    on(event: string, handler: (payload: unknown) => void) {
      listeners.set(event, handler);
    },
    off(event: string, handler: (payload: unknown) => void) {
      if (listeners.get(event) === handler) {
        listeners.delete(event);
      }
    },
    context() {
      return {
        async newCDPSession() {
          return {
            async send() {
              return undefined;
            },
            on() {
              return undefined;
            },
            off() {
              return undefined;
            },
            async detach() {
              return undefined;
            },
          };
        },
      };
    },
  } as unknown as Page;

  await attachPageEvents(page, listener);
  return {
    emit(event: string, payload: unknown) {
      listeners.get(event)?.(payload);
    },
  };
}

function request(): Request {
  return {
    url: () => "https://example.test/path",
    method: () => "GET",
    resourceType: () => "document",
  } as Request;
}
