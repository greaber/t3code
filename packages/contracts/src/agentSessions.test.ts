import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_SESSION_IMPORT_SKIPPED_EXAMPLES,
  mergeSkippedImportGroups,
} from "./agentSessions.ts";

describe("mergeSkippedImportGroups", () => {
  it("sums counts per reason and keeps a bounded list of example paths", () => {
    const example = (index: number) => ({ provider: "codex" as const, filePath: `/t/${index}` });
    const many = Array.from({ length: 70 }, (_, index) => ({
      reason: "too_large" as const,
      count: 1,
      examples: [example(index)],
    }));
    const merged = mergeSkippedImportGroups([
      ...many,
      { reason: "no_conversation", count: 3, examples: [example(100)] },
      { reason: "too_large", count: 5, examples: [] },
    ]);
    expect(merged.map((group) => [group.reason, group.count])).toEqual([
      ["too_large", 75],
      ["no_conversation", 3],
    ]);
    expect(merged[0]?.examples).toHaveLength(AGENT_SESSION_IMPORT_SKIPPED_EXAMPLES);
    expect(merged[0]?.examples[0]).toEqual(example(0));
  });
});
