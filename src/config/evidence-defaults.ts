/** Default screenshot settle and capture options (project `evidence.screenshotOptions`). */
export const DEFAULT_SCREENSHOT_SETTLE_DELAY_MS = 1500;
export const DEFAULT_SCREENSHOT_LOAD_TIMEOUT_MS = 15_000;
export const DEFAULT_SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS = 5000;

export const DEFAULT_CURSOR_SHOW_ON_ACTIONS = [
  "hover",
  "click",
  "select",
  "check",
  "uncheck",
  "drag",
  "move",
] as const;

export const DEFAULT_VIDEO_WIDTH = 1280;
export const DEFAULT_VIDEO_HEIGHT = 720;
export const DEFAULT_FFMPEG_CRF = 23;

/** Parsed defaults for optional `evidence` capture blocks (tests and docs). */
export const EXPECTED_EVIDENCE_CAPTURE = {
  screenshotOptions: {
    waitForLoadState: "networkidle" as const,
    loadTimeoutMs: DEFAULT_SCREENSHOT_LOAD_TIMEOUT_MS,
    networkIdleTimeoutMs: DEFAULT_SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS,
    settleDelayMs: DEFAULT_SCREENSHOT_SETTLE_DELAY_MS,
    animations: "disabled" as const,
    caret: "initial" as const,
    fullPage: false,
  },
  cursor: {
    mode: "auto" as const,
    showOnActions: [...DEFAULT_CURSOR_SHOW_ON_ACTIONS],
    showOnLocatorWait: true,
    showOnFailure: true,
    showOnLowSemanticLocator: true,
    style: "native-arrow" as const,
  },
  video: {
    enabled: false,
    size: { width: DEFAULT_VIDEO_WIDTH, height: DEFAULT_VIDEO_HEIGHT },
    retainOnPass: false,
    retainOnFailure: true,
    ffmpeg: {
      enabled: true,
      outputFormat: "mp4" as const,
      crf: DEFAULT_FFMPEG_CRF,
      preset: "veryfast" as const,
      keepSourceWebm: false,
    },
  },
};
