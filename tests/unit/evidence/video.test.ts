import { expect, test } from "vitest";
import { EXPECTED_EVIDENCE_CAPTURE } from "../../../src/config/evidence-defaults.js";
import {
  buildFfmpegArgs,
  resolveVideoPlan,
  shouldRecordVideo,
  shouldRetainVideo,
} from "../../../src/evidence/video.js";
import { attach } from "../../../src/evidence/store.js";
import { startRun } from "../../../src/evidence/result.js";

const videoPlan = EXPECTED_EVIDENCE_CAPTURE.video;

test("buildFfmpegArgs targets libx264", () => {
  const args = buildFfmpegArgs("/tmp/in.webm", "/tmp/out.mp4", videoPlan);
  expect(args).toContain("-c:v");
  expect(args).toContain("libx264");
  expect(args).toContain("-crf");
  expect(args).toContain("23");
});

test("shouldRecordVideo is false by default", () => {
  expect(shouldRecordVideo(resolveVideoPlan({
    screenshots: "checkpoints",
    network: true,
    console: true,
    trace: "off",
    maxResponseBodyBytes: 1024,
    ...EXPECTED_EVIDENCE_CAPTURE,
  }))).toBe(false);
  expect(shouldRecordVideo(undefined)).toBe(false);
});

test("shouldRetainVideo follows pass and failure policy", () => {
  const enabled = { ...videoPlan, enabled: true };
  expect(shouldRetainVideo(enabled, true)).toBe(false);
  expect(shouldRetainVideo(enabled, false)).toBe(true);
});

test("attach round-trips optional video path", () => {
  const builder = startRun({ runId: "run-video-01", flowId: "demo.flow" });
  const result = builder.finish();
  const runDir = "/tmp/project/.autonomous-qa/artifacts/run-video-01";
  const videoPath = `${runDir}/run-failed.mp4`;
  attach(result, { screenshots: [], video: videoPath });
  expect(result.artifacts.video).toBe("run-failed.mp4");
});
