import { describe, expect, it } from "vite-plus/test";

import {
  BoundedTerminalHistory,
  historyFileRead,
  planHistoryFileWrite,
  releaseHistoryMemory,
  startPageAtLine,
  type HistoryFileWrite,
} from "./History.ts";

/** Applies writes as the manager does, to a file kept as bytes. */
function fileOf(history: BoundedTerminalHistory) {
  let file = Buffer.alloc(0);
  return {
    get text() {
      return file.toString("utf8");
    },
    persist(minCompactionBytes = 64): HistoryFileWrite {
      const write = planHistoryFileWrite(history, minCompactionBytes);
      const text = Buffer.from(write.text);
      file = write.append
        ? Buffer.concat([file, text])
        : Buffer.concat([
            write.copy === null ? Buffer.alloc(0) : file.subarray(write.copy.from, write.copy.to),
            text,
          ]);
      history.persisted = write.persisted;
      // The file ends with the history at the recorded offsets.
      expect(file.length).toBe(write.persisted.end - write.persisted.fileStart);
      return write;
    },
  };
}

describe("BoundedTerminalHistory", () => {
  it("keeps offsets in UTF-8 bytes across trimming and joined surrogates", () => {
    const history = new BoundedTerminalHistory(3, "", 1_000);
    history.append("a名\n");
    expect(history.endOffset).toBe(5);
    history.append("\ud83d");
    history.append("\ude80\n");
    expect(history.endOffset).toBe(10);
    history.append("x\ny\n");
    expect(history.memoryText(history.startOffset)).toBe("🚀\nx\ny\n");
    expect(history.startOffset).toBe(5);
    expect(history.memoryText(5, 9)).toBe("🚀");
    expect(startPageAtLine("ab\ncd", 3, 0, false)).toEqual({ data: "cd", offset: 6 });
  });

  it("releases persisted output from memory while limits still count it", () => {
    const history = new BoundedTerminalHistory(1_000, "", 1_000_000);
    const file = fileOf(history);
    const line = "x".repeat(99) + "\n";
    history.append(line.repeat(400));
    file.persist();
    history.append(line);
    // Unwritten output stays in memory.
    history.spill(0);
    expect(history.memoryStart).toBeLessThanOrEqual(40_000);
    expect(history.memoryText(history.memoryStart).endsWith(line)).toBe(true);
    expect(history.bytes).toBe(40_100);
    // The line limit counts released lines, dropping them a whole segment at a time.
    history.append(line.repeat(700));
    expect(history.startOffset).toBeGreaterThanOrEqual(10_100);
    expect(history.startOffset).toBeLessThan(10_100 + 64 * 1024);
    expect(history.endOffset).toBe(110_100);
  });

  it("appends to its file and rewrites it from the file and memory when mostly trimmed", () => {
    const history = new BoundedTerminalHistory(10, "", 1_000_000);
    const file = fileOf(history);
    history.append("one\ntwo\n");
    expect(file.persist().append).toBe(false);
    history.append("three\n");
    expect(file.persist()).toMatchObject({ append: true, text: "three\n" });
    const long = (index: number) => `line ${index} ${"y".repeat(6_000)}\n`;
    for (let index = 0; index < 20; index += 1) {
      history.append(long(index));
      file.persist(1e9);
    }
    history.spill(0);
    expect(history.memoryStart).toBeGreaterThan(history.startOffset);
    // The trimmed prefix outgrew the retained text, so the file is rebuilt: released
    // output is copied from the old file, the rest written from memory.
    const write = file.persist(64);
    expect(write.append).toBe(false);
    if (write.append) return;
    expect(write.copy).not.toBeNull();
    expect(file.text).toBe(Array.from({ length: 10 }, (_, index) => long(index + 10)).join(""));

    // A split surrogate waits for its pair instead of being written as U+FFFD.
    history.append("\ud83d");
    expect(file.persist(1e9)).toMatchObject({ append: true, text: "" });
    history.append("\ude80\n");
    file.persist(1e9);
    expect(file.text.endsWith("🚀\n")).toBe(true);

    // A failed append leaves the file unknown past what was released, so it is rebuilt.
    history.persisted = { ...history.persisted!, dirty: true };
    history.append("after\n");
    expect(file.persist().append).toBe(false);
    expect(file.text.endsWith("🚀\nafter\n")).toBe(true);

    history.clear();
    expect(file.persist()).toMatchObject({ append: false, copy: null });
    expect(file.text).toBe("");
  });

  it("restores a file's sizes and tail, trimming whole released segments", () => {
    const history = BoundedTerminalHistory.restored(
      5,
      1_000,
      100,
      [
        { bytes: 30, lineBreaks: 3 },
        { bytes: 20, lineBreaks: 2 },
      ],
      "tail\n",
    );
    // Six lines are over the limit; the oldest segment goes whole.
    expect(history.startOffset).toBe(130);
    expect(history.memoryStart).toBe(150);
    expect(history.endOffset).toBe(155);
  });

  it("releases memory from the largest histories first, only as far as needed", () => {
    const histories = [100, 300, 200].map((lines) => {
      const history = new BoundedTerminalHistory(10_000, "", 10_000_000);
      history.append(`${"x".repeat(1_023)}\n`.repeat(lines));
      history.persisted = {
        generation: history.clearGeneration,
        fileStart: 0,
        end: history.endOffset,
      };
      return history;
    });
    releaseHistoryMemory(histories, 500 * 1024, 64 * 1024);
    expect(histories.map((history) => history.memoryBytes <= 100 * 1024 + 16 * 1024)).toEqual([
      true,
      true,
      false,
    ]);
    expect(histories.reduce((sum, history) => sum + history.memoryBytes, 0)).toBeLessThanOrEqual(
      500 * 1024,
    );
  });

  it("starts memory pages at a character and file reads within what the file holds", () => {
    const history = new BoundedTerminalHistory(100, "a名b", 1_000);
    // Byte 2 is inside 名, which starts at 1 and ends at 4.
    expect(history.alignForward(2)).toBe(4);
    expect(history.alignForward(1)).toBe(1);
    expect(history.memoryText(history.alignForward(2))).toBe("b");

    expect(historyFileRead(100, 200, 50, 40)).toEqual({
      from: 100,
      readFrom: 99,
      position: 59,
      length: 101,
    });
    // A rewrite trimmed the history and moved the file's start past the chosen range.
    expect(historyFileRead(100, 200, 150, 150)).toEqual({
      from: 150,
      readFrom: 150,
      position: 0,
      length: 50,
    });
    expect(historyFileRead(100, 200, 250, 250)).toBeNull();
  });
});
