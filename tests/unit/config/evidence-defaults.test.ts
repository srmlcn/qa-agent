import { expect, test } from "vitest";
import { applyProjectDefaults } from "../../../src/config/defaults.js";
import { EXPECTED_EVIDENCE_CAPTURE } from "../../../src/config/evidence-defaults.js";
import { materializeEvidence } from "../../../src/config/materialize-evidence.js";
import { evidenceSchema } from "../../../src/config/schema.js";

test("applyProjectDefaults fills evidence capture blocks", () => {
  const merged = applyProjectDefaults({
    evidence: {
      screenshots: "checkpoints",
      network: true,
      console: true,
      trace: "off",
      maxResponseBodyBytes: 1024,
    },
  }) as { evidence: Record<string, unknown> };

  expect(merged.evidence.screenshotOptions).toEqual(
    EXPECTED_EVIDENCE_CAPTURE.screenshotOptions,
  );
  expect(merged.evidence.cursor).toEqual(EXPECTED_EVIDENCE_CAPTURE.cursor);
  expect(merged.evidence.video).toEqual(EXPECTED_EVIDENCE_CAPTURE.video);
});

test("materializeEvidence preserves user overrides", () => {
  const evidence = materializeEvidence({
    screenshots: "checkpoints",
    network: false,
    console: false,
    trace: "off",
    maxResponseBodyBytes: 512,
    screenshotOptions: {
      waitForLoadState: "load",
      loadTimeoutMs: 1000,
      networkIdleTimeoutMs: 500,
      settleDelayMs: 250,
      animations: "allow",
      caret: "hide",
      fullPage: true,
    },
    cursor: {
      mode: "never",
      showOnActions: ["click"],
      showOnLocatorWait: false,
      showOnFailure: false,
      showOnLowSemanticLocator: false,
      style: "native-arrow",
    },
    video: {
      enabled: true,
      size: { width: 640, height: 480 },
      retainOnPass: true,
      retainOnFailure: false,
      ffmpeg: {
        enabled: false,
        outputFormat: "mp4",
        crf: 18,
        preset: "fast",
        keepSourceWebm: true,
      },
    },
  });

  expect(evidence.screenshotOptions.settleDelayMs).toBe(250);
  expect(evidence.cursor.mode).toBe("never");
  expect(evidence.video.enabled).toBe(true);
  expect(evidenceSchema.safeParse(evidence).success).toBe(true);
});
