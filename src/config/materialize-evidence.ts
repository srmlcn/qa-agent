import { applyProjectDefaults } from "./defaults.js";
import { evidenceSchema, type ProjectConfig } from "./schema.js";

/** Fills omitted evidence capture defaults and validates the evidence block. */
export function materializeEvidence(
  evidence: ProjectConfig["evidence"],
): ProjectConfig["evidence"] {
  const merged = applyProjectDefaults({ evidence }) as { evidence: unknown };
  return evidenceSchema.parse(merged.evidence);
}
