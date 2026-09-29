import type { Page } from "playwright";
import type { Locator as FlowLocator } from "../flows/schema.js";
import { toLocator } from "./locators.js";

const CURSOR_ELEMENT_ID = "autonomous-qa-cursor-overlay";

export type CursorPoint = { x: number; y: number };

/**
 * Tracks the last mouse position on `page` for screenshot anchoring.
 * Safe to call more than once; only one listener is registered.
 */
export async function ensureMouseTracking(page: Page): Promise<void> {
  await page.evaluate(() => {
    const global = window as Window & {
      __autonomousQaMouse?: { x: number; y: number };
      __autonomousQaMouseListener?: boolean;
    };
    if (global.__autonomousQaMouseListener === true) {
      return;
    }
    global.__autonomousQaMouse = { x: 0, y: 0 };
    global.__autonomousQaMouseListener = true;
    window.addEventListener(
      "mousemove",
      (event) => {
        global.__autonomousQaMouse = { x: event.clientX, y: event.clientY };
      },
      { passive: true },
    );
  });
}

export async function readLastMousePosition(page: Page): Promise<CursorPoint | undefined> {
  const point = await page.evaluate(() => {
    const global = window as Window & {
      __autonomousQaMouse?: { x: number; y: number };
    };
    const mouse = global.__autonomousQaMouse;
    if (mouse === undefined || (mouse.x === 0 && mouse.y === 0)) {
      return undefined;
    }
    return mouse;
  });
  return point;
}

export async function resolveCursorAnchor(
  page: Page,
  locator: FlowLocator | undefined,
): Promise<CursorPoint | undefined> {
  if (locator !== undefined) {
    try {
      const box = await toLocator(page, locator).boundingBox();
      if (box !== null) {
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
    } catch {
      // Locator may be detached after the step; fall back to mouse position.
    }
  }
  return await readLastMousePosition(page);
}

export async function injectCursorOverlay(
  page: Page,
  point: CursorPoint,
): Promise<void> {
  await page.evaluate(
    ({ elementId, x, y }) => {
      const existing = document.getElementById(elementId);
      existing?.remove();
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.id = elementId;
      svg.setAttribute("width", "24");
      svg.setAttribute("height", "24");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.style.position = "fixed";
      svg.style.left = `${x}px`;
      svg.style.top = `${y}px`;
      svg.style.zIndex = "2147483647";
      svg.style.pointerEvents = "none";
      svg.style.margin = "0";
      svg.style.padding = "0";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        "M4 2 L4 18 L9 13 L14 21 L17 19 L12 11 L18 11 Z",
      );
      path.setAttribute("fill", "#111");
      path.setAttribute("stroke", "#fff");
      path.setAttribute("stroke-width", "1");
      svg.appendChild(path);
      document.documentElement.appendChild(svg);
    },
    { elementId: CURSOR_ELEMENT_ID, x: point.x, y: point.y },
  );
}

export async function removeCursorOverlay(page: Page): Promise<void> {
  await page.evaluate((elementId) => {
    document.getElementById(elementId)?.remove();
  }, CURSOR_ELEMENT_ID);
}
