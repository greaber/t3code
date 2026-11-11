import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  TERMINAL_VIEW_SCROLLBACK_ROWS,
  TerminalSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";

import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  canLoadNewerTerminalOutput,
  canLoadOlderTerminalOutput,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  nextTerminalAttachSeedState,
  readTerminalOutputUpdate,
  terminalOutputText,
} from "./terminalSession.ts";

const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
  terminalId: "term-1",
} as const;

const BASE_SNAPSHOT: TerminalSessionSnapshot = {
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "hello",
  exitCode: null,
  exitSignal: null,
  label: "Terminal 1",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

describe("terminal session reducers", () => {
  it("prefers live attach status over stale metadata after the attach stream starts", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;
    const attached = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "error",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      message: "Terminal disconnected.",
    });

    expect(combineTerminalSessionState(summary, attached)).toMatchObject({
      status: "error",
      error: "Terminal disconnected.",
      version: 1,
    });
  });

  it("follows the shared PTY grid from snapshots and activity without disturbing output", () => {
    const attached = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, cols: 130, rows: 15 },
    });
    const activity = {
      type: "activity",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      hasRunningSubprocess: false,
      label: "Terminal 1",
    } as const;
    const narrowed = applyTerminalAttachStreamEvent(attached, { ...activity, cols: 54, rows: 15 });
    // Activity from a server without geometry, or a repeat, must not reset the renderer.
    const unchanged = applyTerminalAttachStreamEvent(
      applyTerminalAttachStreamEvent(narrowed, activity),
      { ...activity, cols: 54, rows: 15 },
    );

    expect(attached.grid).toEqual({ cols: 130, rows: 15 });
    expect(narrowed).toEqual({ ...attached, grid: { cols: 54, rows: 15 } });
    expect(unchanged).toBe(narrowed);
  });

  it("preserves a BOM code point at a new output chunk boundary", () => {
    const initial = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "" },
    });
    const cursor = readTerminalOutputUpdate(initial.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    const data = `${"x".repeat(16_384)}\uFEFF${"y".repeat(20)}`;
    const state = applyTerminalAttachStreamEvent(initial, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      data,
    });

    expect(terminalOutputText(state.output)).toBe(data);
    expect(readTerminalOutputUpdate(state.output, cursor)).toMatchObject({ type: "append", data });
    expect(state.output.retainedBytes).toBe(new TextEncoder().encode(data).byteLength);
  });

  it("preserves a leading BOM in the retained snapshot tail", () => {
    const state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      { type: "snapshot", snapshot: { ...BASE_SNAPSHOT, history: "discard\uFEFFtail" } },
      7,
    );

    expect(terminalOutputText(state.output)).toBe("\uFEFFtail");
    expect(state.output.retainedBytes).toBe(7);
  });

  it("trims whole Unicode code points from a partially retained chunk", () => {
    let state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      { type: "snapshot", snapshot: { ...BASE_SNAPSHOT, history: "é界🙂end" } },
      12,
    );
    let cursor = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    for (const [data, expected, retainedBytes] of [
      ["x", "界🙂endx", 11],
      ["yz", "🙂endxyz", 10],
      ["abc", "endxyzabc", 9],
    ] as const) {
      state = applyTerminalAttachStreamEvent(
        state,
        { type: "output", threadId: TARGET.threadId, terminalId: TARGET.terminalId, data },
        12,
      );
      const update = readTerminalOutputUpdate(state.output, cursor);
      expect(update).toMatchObject({ type: "append", data });
      expect(terminalOutputText(state.output)).toBe(expected);
      expect(state.output.retainedBytes).toBe(retainedBytes);
      cursor = update.cursor;
    }
  });

  it("delivers all output when several events arrive before a renderer reads", () => {
    const initial = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const cursor = readTerminalOutputUpdate(initial.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    let state = initial;
    for (const data of [" one", " two", " three"]) {
      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data,
      });
    }
    const update = readTerminalOutputUpdate(state.output, cursor);
    expect(update).toMatchObject({ type: "append", data: " one two three" });
    expect(readTerminalOutputUpdate(state.output, update.cursor).type).toBe("none");
  });

  it("bounds historical chunk inspection when reading new tail output", () => {
    let state = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "" },
    });
    for (let index = 0; index < 512; index += 1) {
      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "history\r\n",
      });
    }
    const cursor = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    const next = applyTerminalAttachStreamEvent(state, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      data: "latest\r\n",
    });
    let historicalChunkReads = 0;
    const chunks = next.output.chunks.map((chunk, index) =>
      index < state.output.chunks.length
        ? {
            ...chunk,
            get startOffset() {
              historicalChunkReads += 1;
              return chunk.startOffset;
            },
          }
        : chunk,
    );

    expect(readTerminalOutputUpdate({ ...next.output, chunks }, cursor)).toMatchObject({
      type: "append",
      data: "latest\r\n",
    });
    expect(historicalChunkReads).toBeLessThanOrEqual(2);
  });

  it("preserves the byte-limited tail and resets a cursor before a partially trimmed chunk", () => {
    const initial = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "" },
    });
    const staleCursor = readTerminalOutputUpdate(
      initial.output,
      INITIAL_TERMINAL_OUTPUT_CURSOR,
    ).cursor;
    const first = applyTerminalAttachStreamEvent(initial, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      data: "hello",
    });
    const caughtUpCursor = readTerminalOutputUpdate(first.output, staleCursor).cursor;
    const state = applyTerminalAttachStreamEvent(
      first,
      { type: "output", threadId: TARGET.threadId, terminalId: TARGET.terminalId, data: " world" },
      8,
    );

    expect(readTerminalOutputUpdate(state.output, caughtUpCursor)).toMatchObject({
      type: "append",
      data: " world",
    });
    expect(readTerminalOutputUpdate(state.output, staleCursor)).toMatchObject({
      type: "reset",
      data: "lo world",
    });
    expect(state.output.retainedBytes).toBe(8);
  });

  it("resets for repeated snapshots, clear, and restart even when output text repeats", () => {
    let state = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    let cursor = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    const attachedGeneration = state.output.generation;
    // A socket reconnect resubscribes the same stream, so the server's new snapshot gets no seed.
    state = applyTerminalAttachStreamEvent(state, { type: "snapshot", snapshot: BASE_SNAPSHOT });
    const repeated = readTerminalOutputUpdate(state.output, cursor);
    expect(repeated).toMatchObject({ type: "reset", data: "hello" });
    expect(state.version).toBe(2);
    // Viewers replay their measured grid once per generation; the new attachment holds the old size.
    expect(state.output.generation).not.toBe(attachedGeneration);
    cursor = repeated.cursor;

    state = applyTerminalAttachStreamEvent(state, {
      type: "cleared",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
    });
    const cleared = readTerminalOutputUpdate(state.output, cursor);
    expect(cleared).toMatchObject({ type: "reset", data: "" });
    state = applyTerminalAttachStreamEvent(state, {
      type: "restarted",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      snapshot: BASE_SNAPSHOT,
    });
    expect(readTerminalOutputUpdate(state.output, cleared.cursor)).toMatchObject({
      type: "reset",
      data: "hello",
    });
    expect(state.lifecycleVersion).toBe(2);
  });

  it("slides its window through server history and back to the live output", () => {
    const output = (data: string, historyEnd: number) =>
      ({
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data,
        historyEnd,
      }) as const;
    const page = (data: string, offset: number, end: number, more = true) => ({
      data,
      offset,
      end,
      olderHistory: offset > 0,
      newerHistory: more,
    });
    const budget = 8;
    const apply = (
      state: typeof EMPTY_TERMINAL_BUFFER_STATE,
      event: Parameters<typeof applyTerminalAttachStreamEvent>[1],
    ) => applyTerminalAttachStreamEvent(state, event, budget);
    let state = apply(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: {
        ...BASE_SNAPSHOT,
        history: "c\nd\n",
        historyOffset: 4,
        historyEnd: 8,
        olderHistory: true,
      },
    });
    state = apply(state, output("$ ", 10));
    let cursor = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    expect(canLoadOlderTerminalOutput(state.output)).toBe(true);

    // A page that does not end where the held output starts is stale.
    expect(apply(state, { type: "olderHistory", page: page("x\n", 1, 3) })).toBe(state);

    // Older output past the budget pushes out the newest, and the window detaches.
    state = apply(state, { type: "olderHistory", page: page("a\nb\n", 0, 4) });
    expect(terminalOutputText(state.output)).toBe("a\nb\nc\nd\n");
    expect(state.output.detached).toMatchObject({ end: 8, bufferedFrom: 10 });
    expect(canLoadOlderTerminalOutput(state.output)).toBe(false);
    expect(canLoadNewerTerminalOutput(state.output)).toBe(true);
    const prepended = readTerminalOutputUpdate(state.output, cursor);
    expect(prepended).toMatchObject({ type: "reset", anchor: { split: 4, keep: "start" } });
    cursor = prepended.cursor;

    // Live output waits aside while the window shows older output.
    state = apply(state, output("x\n", 12));
    expect(readTerminalOutputUpdate(state.output, cursor).type).toBe("none");

    // A newer page reaching the server's end drops the oldest output and follows live again.
    state = apply(state, { type: "newerHistory", page: page("$ x\n", 8, 12, false) });
    expect(terminalOutputText(state.output)).toBe("c\nd\n$ x\n");
    expect(state.output).toMatchObject({ detached: null, historyOffset: 4, olderHistory: true });
    expect(readTerminalOutputUpdate(state.output, cursor)).toMatchObject({
      type: "reset",
      anchor: { split: 4, keep: "end" },
    });
    state = apply(state, output("y\n", 14));
    expect(terminalOutputText(state.output)).toBe("d\n$ x\ny\n");
    expect(state.output.historyOffset).toBe(6);

    // Jumping to the latest output replaces a detached window and replays what came after.
    state = apply(state, { type: "olderHistory", page: page("b\nc\n", 2, 6) });
    expect(state.output.detached).not.toBeNull();
    state = apply(state, output("z\n", 16));
    state = apply(state, { type: "latestHistory", page: page("$ x\ny\n", 8, 14, false) });
    expect(terminalOutputText(state.output)).toBe("$ x\ny\nz\n");
    expect(state.output.detached).toBeNull();
  });

  it("keeps its start at a known offset when live output arrives in large events", () => {
    let state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "snapshot",
        snapshot: { ...BASE_SNAPSHOT, history: "", historyOffset: 0, historyEnd: 0 },
      },
      256 * 1024,
    );
    let end = 0;
    // Each event splits into chunks; only the last knows its server offset.
    const event = `${"x".repeat(41 * 1024 - 1)}\n`;
    for (let index = 0; index < 20; index += 1) {
      end += event.length;
      state = applyTerminalAttachStreamEvent(
        state,
        {
          type: "output",
          threadId: TARGET.threadId,
          terminalId: TARGET.terminalId,
          data: event,
          historyEnd: end,
        },
        256 * 1024,
      );
      // Once the window drops output, its start is where an event ended.
      if (end <= 256 * 1024) continue;
      expect(canLoadOlderTerminalOutput(state.output)).toBe(true);
      expect((end - state.output.historyOffset!) % event.length).toBe(0);
    }
  });

  it("holds no more output than a narrow view can show", () => {
    let state = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "activity",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      hasRunningSubprocess: false,
      label: "Terminal 1",
      cols: 40,
      rows: 20,
    });
    state = applyTerminalAttachStreamEvent(state, {
      type: "snapshot",
      snapshot: {
        ...BASE_SNAPSHOT,
        history: "",
        historyOffset: 0,
        historyEnd: 0,
        cols: 40,
        rows: 20,
      },
    });
    const line = `${"y".repeat(399)}\n`;
    let end = 0;
    for (let index = 0; index < 100; index += 1) {
      const data = line.repeat(256);
      end += data.length;
      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data,
        historyEnd: end,
      });
    }
    // Each 400-character line takes ten rows at 40 columns.
    const rows = state.output.retainedLines * 10;
    expect(rows).toBeLessThanOrEqual(TERMINAL_VIEW_SCROLLBACK_ROWS);
    // An older page still fits, pushing out the newest output instead.
    const page = line.repeat(64);
    state = applyTerminalAttachStreamEvent(state, {
      type: "olderHistory",
      page: {
        data: page,
        offset: state.output.historyOffset! - page.length,
        end: state.output.historyOffset!,
        olderHistory: true,
        newerHistory: true,
      },
    });
    expect(terminalOutputText(state.output).startsWith(page)).toBe(true);
    expect(state.output.retainedLines * 10).toBeLessThanOrEqual(TERMINAL_VIEW_SCROLLBACK_ROWS);
  });

  it("shows where the server trimmed output a paused view had not reached", () => {
    let state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "snapshot",
        snapshot: { ...BASE_SNAPSHOT, history: "c\nd\n", historyOffset: 4, historyEnd: 8 },
      },
      8,
    );
    state = applyTerminalAttachStreamEvent(
      state,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "$ ",
        historyEnd: 10,
      },
      8,
    );
    state = applyTerminalAttachStreamEvent(
      state,
      {
        type: "olderHistory",
        page: { data: "a\nb\n", offset: 0, end: 4, olderHistory: false, newerHistory: true },
      },
      8,
    );
    expect(state.output.detached).toMatchObject({ end: 8 });
    // The server trimmed past the paused view's end; its next page starts later.
    state = applyTerminalAttachStreamEvent(
      state,
      {
        type: "newerHistory",
        page: { data: "new\n", offset: 20, end: 24, olderHistory: false, newerHistory: false },
      },
      256,
    );
    expect(terminalOutputText(state.output)).toContain("Earlier output was removed");
    expect(terminalOutputText(state.output).endsWith("new\n")).toBe(true);
    expect(state.output.detached).toBeNull();
  });

  it("does not reuse a renderer cursor when a fresh attach has matching counters", () => {
    const first = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const cursor = readTerminalOutputUpdate(first.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    const next = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "other" },
    });
    expect(next.output.resetVersion).toBe(first.output.resetVersion);
    expect(next.output.nextOffset).toBe(first.output.nextOffset);
    expect(readTerminalOutputUpdate(next.output, cursor)).toMatchObject({
      type: "reset",
      data: "other",
    });
    expect(next.lifecycleVersion).toBe(0);
  });

  it("appends every unread character across a compaction boundary", () => {
    let state = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "" },
    });
    let cursor = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    const writes = Array.from({ length: 1200 }, (_, index) => ["x", "é", "界", "🙂"][index % 4]!);
    for (const [index, data] of writes.entries()) {
      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data,
      });
      if (index === 99) cursor = readTerminalOutputUpdate(state.output, cursor).cursor;
    }
    expect(readTerminalOutputUpdate(state.output, cursor)).toMatchObject({
      type: "append",
      data: writes.slice(100).join(""),
    });
  });
});
