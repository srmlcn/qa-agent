import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { ProjectConfig } from "../config/schema.js";
import { assertArtifactPath } from "./screenshots.js";

export type VideoPlan = ProjectConfig["evidence"]["video"];

export type FinalizeVideoOptions = {
  context: BrowserContext;
  page: Page;
  destDir: string;
  plan: VideoPlan;
  runPassed: boolean;
};

export type FinalizeVideoResult = {
  path?: string;
  warning?: string;
};

let ffmpegAvailableCache: boolean | undefined;

/**
 * Resolves the project video plan. Present for symmetry with screenshot planning.
 */
export function resolveVideoPlan(
  evidence: ProjectConfig["evidence"],
): VideoPlan {
  return evidence.video;
}

export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  plan: VideoPlan,
): string[] {
  const ffmpeg = plan.ffmpeg;
  return [
    "-y",
    "-i",
    inputPath,
    "-c:v",
    "libx264",
    "-preset",
    ffmpeg.preset,
    "-crf",
    String(ffmpeg.crf),
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ];
}

export function recordVideoDir(destDir: string): string {
  const dir = join(destDir, "video");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function shouldRecordVideo(plan: VideoPlan | undefined): boolean {
  return plan?.enabled === true;
}

export function shouldRetainVideo(plan: VideoPlan, runPassed: boolean): boolean {
  if (!plan.enabled) {
    return false;
  }
  return runPassed ? plan.retainOnPass : plan.retainOnFailure;
}

export async function probeFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailableCache !== undefined) {
    return ffmpegAvailableCache;
  }
  ffmpegAvailableCache = await probeFfmpegOnce();
  return ffmpegAvailableCache;
}

export function resetFfmpegProbeCache(): void {
  ffmpegAvailableCache = undefined;
}

async function probeFfmpegOnce(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.on("error", () => {
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

/**
 * After the browser context closes, returns a retained video path under `destDir`.
 * Transcodes to mp4 when ffmpeg is available and configured.
 */
export async function finalizeVideo(
  options: FinalizeVideoOptions,
): Promise<FinalizeVideoResult> {
  const { page, destDir, plan, runPassed } = options;
  if (!plan.enabled) {
    return {};
  }

  const video = page.video();
  if (video === null) {
    return {};
  }

  let sourcePath: string | undefined;
  try {
    sourcePath = await video.path();
  } catch {
    return {};
  }
  if (sourcePath === undefined || !existsSync(sourcePath)) {
    return {};
  }

  if (!shouldRetainVideo(plan, runPassed)) {
    removeFile(sourcePath);
    return {};
  }

  const retainedName = runPassed ? "run.webm" : "run-failed.webm";
  const retainedWebm = assertArtifactPath(join(destDir, retainedName));
  mkdirSync(dirname(retainedWebm), { recursive: true });
  try {
    renameSync(sourcePath, retainedWebm);
  } catch {
    return { warning: "VIDEO_RETAIN_FAILED" };
  }

  if (!plan.ffmpeg.enabled) {
    return { path: retainedWebm };
  }

  const ffmpegOk = await probeFfmpegAvailable();
  if (!ffmpegOk) {
    return { path: retainedWebm, warning: "FFMPEG_MISSING" };
  }

  const mp4Path = assertArtifactPath(
    join(destDir, retainedName.replace(/\.webm$/i, `.${plan.ffmpeg.outputFormat}`)),
  );
  const args = buildFfmpegArgs(retainedWebm, mp4Path, plan);
  const transcodeOk = await runFfmpeg(args);
  if (!transcodeOk) {
    return { path: retainedWebm, warning: "FFMPEG_TRANSCODE_FAILED" };
  }

  if (!plan.ffmpeg.keepSourceWebm) {
    removeFile(retainedWebm);
  }
  return { path: mp4Path };
}

async function runFfmpeg(args: string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.on("error", () => {
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

function removeFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Best effort cleanup.
    }
  }
}
