import { isAbsolute } from "node:path";
import { z } from "zod";
import type { RunResult } from "../../evidence/types.js";
import { getRun, type RunRecord } from "../../orchestrator/runs.js";
import type { McpTool } from "../load-tools.js";

const schema = z.object({
  runId: z.string().min(1),
});

/** Serializable run record. The live AbortSignal is omitted. */
export type GetRunOutput = {
  runId: string;
  flowId: string;
  status: RunRecord["status"];
  result?: RunResult;
  artifacts?: string[];
};

export const tool = {
  name: "qa.get_run",
  description: "Return a stored run record and its relative artifact paths.",
  schema,
  async handler(args: unknown): Promise<GetRunOutput> {
    const input = schema.parse(args);
    const record = getRun(input.runId);
    const output: GetRunOutput = {
      runId: record.runId,
      flowId: record.flowId,
      status: record.status,
    };
    if (record.result !== undefined) {
      output.result = record.result;
      output.artifacts = relativeArtifactPaths(record.result);
    }
    return output;
  },
} satisfies McpTool;

function relativeArtifactPaths(result: RunResult): string[] {
  const paths = [...result.artifacts.screenshots];
  if (result.artifacts.trace !== undefined) {
    paths.push(result.artifacts.trace);
  }
  return paths.filter((artifactPath) => !isAbsolute(artifactPath));
}
