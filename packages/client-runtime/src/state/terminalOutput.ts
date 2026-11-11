import { MAX_TERMINAL_BUFFER_LINES, TERMINAL_HISTORY_PAGE_BYTES } from "@t3tools/contracts";

export interface TerminalOutputChunk {
  readonly startOffset: number;
  readonly data: string;
  readonly byteLength: number;
  readonly lineBreaks: number;
  /** The server's history offset where this chunk ends, when known. */
  readonly serverEnd: number | null;
  /** Ends inside output whose end a later chunk knows. */
  readonly pendingEnd: boolean;
  /** The server's own text, so its bytes map to history offsets. */
  readonly exact: boolean;
}

/** The held output ends before the live output, after older output was read in. */
export interface TerminalDetachedWindow {
  /** The server offset where the held output ends. */
  readonly end: number;
  /** Live output that arrived meanwhile, with the server offset where each ends. */
  readonly buffered: ReadonlyArray<{ readonly data: string; readonly end: number }>;
  /** The server offset where `buffered` starts. */
  readonly bufferedFrom: number;
}

/** How a reset relates to what a reader showed, so it can keep the reader's place. */
export interface TerminalOutputAnchor {
  /** Where, in the reset's text, the text the reader had starts (`start`) or ends (`end`). */
  readonly split: number;
  readonly keep: "start" | "end";
}

export interface TerminalOutputState {
  readonly generation: number;
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly retainedBytes: number;
  readonly retainedLines: number;
  readonly resetVersion: number;
  readonly nextOffset: number;
  /** The server offset where the held output starts, or null when unknown. */
  readonly historyOffset: number | null;
  /** The server keeps output before `historyOffset`. */
  readonly olderHistory: boolean;
  readonly detached: TerminalDetachedWindow | null;
  readonly anchor: (TerminalOutputAnchor & { readonly resetVersion: number }) | null;
}

export interface TerminalOutputCursor {
  readonly generation: number;
  readonly resetVersion: number;
  readonly offset: number;
}

export const INITIAL_TERMINAL_OUTPUT_CURSOR = Object.freeze<TerminalOutputCursor>({
  generation: -1,
  resetVersion: -1,
  offset: 0,
});

export type TerminalOutputUpdate =
  | {
      readonly type: "none";
      readonly cursor: TerminalOutputCursor;
    }
  | {
      readonly type: "reset";
      readonly data: string;
      readonly cursor: TerminalOutputCursor;
      /** Set when the reader's last text is part of this one, so it can keep its place. */
      readonly anchor: TerminalOutputAnchor | null;
    }
  | {
      readonly type: "append";
      readonly cursor: TerminalOutputCursor;
      readonly data: string;
    };

/** A page of server output, as `terminal.history` returns it. */
export interface TerminalHistoryPageInput {
  readonly data: string;
  readonly offset: number;
  readonly end: number;
  readonly olderHistory: boolean;
  readonly newerHistory: boolean;
}

const DEFAULT_TERMINAL_CHUNK_BYTES = 16 * 1024;
// Enough 16 KiB chunks for the default buffer; compaction keeps chunks near that size.
const MAX_TERMINAL_OUTPUT_CHUNKS = 2_048;
// Live output kept aside while the held output ends before it.
const MAX_DETACHED_BUFFER_BYTES = TERMINAL_HISTORY_PAGE_BYTES;
const textEncoder = new TextEncoder();
// A BOM at a retained chunk boundary is terminal data, not an encoding marker.
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

export const EMPTY_TERMINAL_OUTPUT_STATE = Object.freeze<TerminalOutputState>({
  generation: 0,
  chunks: Object.freeze([]),
  retainedBytes: 0,
  retainedLines: 0,
  resetVersion: 0,
  nextOffset: 0,
  historyOffset: null,
  olderHistory: false,
  detached: null,
  anchor: null,
});

const utf8Length = (data: string) => textEncoder.encode(data).byteLength;

const countLineBreaks = (data: string) => {
  let lineBreaks = 0;
  for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
    lineBreaks += 1;
  }
  return lineBreaks;
};

const utf8Width = (codePoint: number) =>
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;

function splitStringByUtf8Bytes(
  data: string,
  maxBytes: number,
): ReadonlyArray<{ readonly data: string; readonly byteLength: number }> {
  if (data.length === 0) return [];
  const encoded = textEncoder.encode(data);
  if (encoded.byteLength <= maxBytes) return [{ data, byteLength: encoded.byteLength }];
  const chunks: Array<{ data: string; byteLength: number }> = [];
  let offset = 0;
  while (offset < encoded.byteLength) {
    let end = Math.min(offset + maxBytes, encoded.byteLength);
    while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    // A degenerate budget smaller than one code point still has to advance.
    if (end === offset) {
      end = Math.min(offset + maxBytes, encoded.byteLength);
      while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) end += 1;
    }
    const bytes = encoded.subarray(offset, end);
    chunks.push({ data: textDecoder.decode(bytes), byteLength: bytes.byteLength });
    offset = end;
  }
  return chunks;
}

/**
 * Chunks for `data`, numbered from `firstOffset`. Exact text gets the server offset at
 * every chunk end; live output only at its last one.
 */
function makeChunks(
  data: string,
  firstOffset: number,
  source: { readonly exact: boolean; readonly serverEnd: number | null },
  maxChunkBytes = DEFAULT_TERMINAL_CHUNK_BYTES,
): ReadonlyArray<TerminalOutputChunk> {
  const split = splitStringByUtf8Bytes(data, maxChunkBytes);
  const totalBytes = split.reduce((total, chunk) => total + chunk.byteLength, 0);
  let startOffset = firstOffset;
  let consumed = 0;
  return split.map((chunk, index) => {
    consumed += chunk.byteLength;
    const last = index === split.length - 1;
    const serverEnd =
      source.serverEnd === null
        ? null
        : last
          ? source.serverEnd
          : source.exact
            ? source.serverEnd - totalBytes + consumed
            : null;
    const made: TerminalOutputChunk = {
      startOffset,
      data: chunk.data,
      byteLength: chunk.byteLength,
      lineBreaks: countLineBreaks(chunk.data),
      serverEnd,
      pendingEnd: serverEnd === null && source.serverEnd !== null,
      exact: source.exact,
    };
    startOffset += chunk.data.length;
    return made;
  });
}

function renumber(chunks: ReadonlyArray<TerminalOutputChunk>, firstOffset = 0) {
  let startOffset = firstOffset;
  return chunks.map((chunk) => {
    const renumbered = { ...chunk, startOffset };
    startOffset += chunk.data.length;
    return renumbered;
  });
}

function compactRetainedChunks(chunks: ReadonlyArray<TerminalOutputChunk>) {
  const compacted: TerminalOutputChunk[] = [];
  for (const chunk of chunks) {
    const previous = compacted.at(-1);
    if (
      previous !== undefined &&
      previous.startOffset + previous.data.length === chunk.startOffset &&
      previous.byteLength + chunk.byteLength <= DEFAULT_TERMINAL_CHUNK_BYTES
    ) {
      compacted[compacted.length - 1] = {
        startOffset: previous.startOffset,
        data: `${previous.data}${chunk.data}`,
        byteLength: previous.byteLength + chunk.byteLength,
        lineBreaks: previous.lineBreaks + chunk.lineBreaks,
        serverEnd: chunk.serverEnd,
        pendingEnd: chunk.pendingEnd,
        exact: previous.exact && chunk.exact,
      };
    } else {
      compacted.push(chunk);
    }
  }
  return compacted;
}

/** Drops leading characters of `chunk` until at least `bytes` bytes or `lines` lines are gone. */
function trimChunkStart(chunk: TerminalOutputChunk, bytes: number, lines: number) {
  let offset = 0;
  let droppedBytes = 0;
  let droppedLines = 0;
  while ((droppedBytes < bytes || droppedLines < lines) && offset < chunk.data.length) {
    const codePoint = chunk.data.codePointAt(offset)!;
    droppedBytes += utf8Width(codePoint);
    offset += codePoint <= 0xffff ? 1 : 2;
    if (codePoint === 10) droppedLines += 1;
  }
  return {
    chunk: {
      ...chunk,
      startOffset: chunk.startOffset + offset,
      data: chunk.data.slice(offset),
      byteLength: chunk.byteLength - droppedBytes,
      lineBreaks: chunk.lineBreaks - droppedLines,
    },
    droppedBytes,
  };
}

interface Window {
  chunks: TerminalOutputChunk[];
  bytes: number;
  lines: number;
  historyOffset: number | null;
  dropped: boolean;
}

/**
 * Drops the oldest output until the window fits. Output whose server offsets are known
 * goes a chunk at a time (live output) or exactly (server text), so the window's start
 * stays a known offset older output can be read before.
 */
function trimFront(window: Window, maxBytes: number, maxLines: number): void {
  while (window.chunks.length > 0 && (window.bytes > maxBytes || window.lines > maxLines)) {
    const first = window.chunks[0]!;
    const bytesOver = window.bytes - maxBytes;
    const linesOver = window.lines - maxLines;
    window.dropped = true;
    const whole = first.byteLength <= bytesOver || first.lineBreaks <= linesOver - 1;
    if (!whole && (first.exact || (first.serverEnd === null && !first.pendingEnd))) {
      const trimmed = trimChunkStart(first, Math.max(0, bytesOver), Math.max(0, linesOver));
      window.bytes -= trimmed.droppedBytes;
      window.lines -= first.lineBreaks - trimmed.chunk.lineBreaks;
      window.historyOffset =
        first.exact && window.historyOffset !== null
          ? window.historyOffset + trimmed.droppedBytes
          : null;
      if (trimmed.chunk.data.length > 0) {
        window.chunks[0] = trimmed.chunk;
        continue;
      }
      window.chunks.shift();
      continue;
    }
    window.chunks.shift();
    window.bytes -= first.byteLength;
    window.lines -= first.lineBreaks;
    window.historyOffset =
      first.serverEnd ??
      (first.exact && window.historyOffset !== null
        ? window.historyOffset + first.byteLength
        : null);
  }
}

function windowOf(state: TerminalOutputState, chunks: ReadonlyArray<TerminalOutputChunk>): Window {
  return {
    chunks: [...chunks],
    bytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    lines: chunks.reduce((total, chunk) => total + chunk.lineBreaks, 0),
    historyOffset: state.historyOffset,
    dropped: false,
  };
}

function fromWindow(
  current: TerminalOutputState,
  window: Window,
  changes: Partial<TerminalOutputState>,
): TerminalOutputState {
  let chunks = window.chunks;
  if (chunks.length > MAX_TERMINAL_OUTPUT_CHUNKS) chunks = compactRetainedChunks(chunks);
  const last = chunks.at(-1);
  return {
    ...current,
    chunks,
    retainedBytes: window.bytes,
    retainedLines: window.lines,
    historyOffset: window.historyOffset,
    olderHistory: window.historyOffset !== null && (current.olderHistory || window.dropped),
    nextOffset: last === undefined ? current.nextOffset : last.startOffset + last.data.length,
    ...changes,
  };
}

/** Live output. While the window is detached it waits aside, so it can follow the window. */
function appendOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
  serverEnd?: number,
  maxLines = MAX_TERMINAL_BUFFER_LINES,
): TerminalOutputState {
  if (data.length === 0) return current;
  const detached = current.detached;
  if (detached !== null && serverEnd !== undefined) {
    const buffered = [...detached.buffered, { data, end: serverEnd }];
    let bufferedFrom = detached.bufferedFrom;
    let bytes = buffered.reduce((total, entry) => total + entry.data.length, 0);
    while (bytes > MAX_DETACHED_BUFFER_BYTES && buffered.length > 1) {
      const dropped = buffered.shift()!;
      bytes -= dropped.data.length;
      bufferedFrom = dropped.end;
    }
    return { ...current, detached: { ...detached, buffered, bufferedFrom } };
  }
  if (maxBufferBytes <= 0) {
    return {
      ...current,
      chunks: [],
      retainedBytes: 0,
      retainedLines: 0,
      resetVersion: current.resetVersion + 1,
      nextOffset: current.nextOffset + data.length,
      historyOffset: null,
      olderHistory: false,
      detached: null,
      anchor: null,
    };
  }
  const window = windowOf(current, [
    ...current.chunks,
    ...makeChunks(
      data,
      current.nextOffset,
      { exact: false, serverEnd: serverEnd ?? null },
      Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
    ),
  ]);
  trimFront(window, maxBufferBytes, maxLines);
  return fromWindow(current, window, {
    nextOffset: current.nextOffset + data.length,
  });
}

/** Replaces the output, as a snapshot, clear, or restart does. */
function resetOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
  history?: { readonly offset: number; readonly end: number; readonly older: boolean },
  maxLines = MAX_TERMINAL_BUFFER_LINES,
): TerminalOutputState {
  const window: Window = {
    chunks: [
      ...makeChunks(
        data,
        0,
        history === undefined
          ? { exact: false, serverEnd: null }
          : { exact: true, serverEnd: history.end },
        Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
      ),
    ],
    bytes: utf8Length(data),
    lines: countLineBreaks(data),
    historyOffset: history?.offset ?? null,
    dropped: false,
  };
  if (maxBufferBytes <= 0) {
    window.chunks = [];
    window.bytes = 0;
    window.lines = 0;
  }
  trimFront(window, Math.max(0, maxBufferBytes), maxLines);
  return {
    ...fromWindow({ ...current, olderHistory: history?.older ?? false }, window, {}),
    resetVersion: current.resetVersion + 1,
    detached: null,
    anchor: null,
  };
}

/** Where the held output ends on the server, when known. */
function windowEnd(state: TerminalOutputState): number | null {
  if (state.detached !== null) return state.detached.end;
  return state.chunks.at(-1)?.serverEnd ?? null;
}

/** Whether older server output can be read in front of what is held. */
export function canLoadOlderTerminalOutput(output: TerminalOutputState): boolean {
  return output.olderHistory && output.historyOffset !== null && windowEnd(output) !== null;
}

/** Whether the held output ends before the live output, so newer output can be read in. */
export function canLoadNewerTerminalOutput(output: TerminalOutputState): boolean {
  return output.detached !== null;
}

/**
 * Puts a page of older output in front of what is held. Past the budget the newest output
 * goes, and the window detaches from the live output until newer pages bring it back.
 * A page that does not end where the held output starts is stale and ignored.
 */
function prependOutput(
  current: TerminalOutputState,
  page: TerminalHistoryPageInput,
  maxBufferBytes: number,
  maxLines = MAX_TERMINAL_BUFFER_LINES,
): TerminalOutputState {
  const end = windowEnd(current);
  if (current.historyOffset === null || page.end !== current.historyOffset || end === null) {
    return current;
  }
  if (page.data.length === 0) {
    return page.olderHistory === current.olderHistory
      ? current
      : { ...current, olderHistory: page.olderHistory };
  }
  const added = makeChunks(page.data, 0, { exact: true, serverEnd: page.end });
  const chunks = renumber([...added, ...current.chunks]);
  let bytes = current.retainedBytes + utf8Length(page.data);
  let lines = current.retainedLines + countLineBreaks(page.data);
  // Drop the newest output, keeping the end at a known offset, until the window fits.
  let newEnd = end;
  let droppedNewest = false;
  while (chunks.length > added.length && (bytes > maxBufferBytes || lines > maxLines)) {
    const last = chunks.pop()!;
    bytes -= last.byteLength;
    lines -= last.lineBreaks;
    droppedNewest = true;
    while (chunks.length > added.length && chunks.at(-1)!.serverEnd === null) {
      const unknown = chunks.pop()!;
      bytes -= unknown.byteLength;
      lines -= unknown.lineBreaks;
    }
    newEnd = chunks.at(-1)!.serverEnd!;
  }
  const window: Window = { chunks, bytes, lines, historyOffset: page.offset, dropped: false };
  // A page larger than the whole budget keeps its newest part.
  trimFront(window, maxBufferBytes, maxLines);
  const split =
    added.reduce((total, chunk) => total + chunk.data.length, 0) -
    (window.chunks[0]?.startOffset ?? 0);
  const resetVersion = current.resetVersion + 1;
  const detached =
    current.detached !== null
      ? { ...current.detached, end: newEnd }
      : droppedNewest
        ? { end: newEnd, buffered: [], bufferedFrom: end }
        : null;
  return {
    ...fromWindow(
      { ...current, olderHistory: page.olderHistory },
      { ...window, chunks: renumber(window.chunks) },
      {},
    ),
    olderHistory: page.olderHistory || window.dropped,
    resetVersion,
    detached,
    anchor: { resetVersion, split: Math.max(0, split), keep: "start" },
  };
}

/**
 * Appends a page of newer output to a detached window, dropping the oldest output past the
 * budget. A page that reached the server's end brings the window back to the live output.
 */
function appendNewerOutput(
  current: TerminalOutputState,
  page: TerminalHistoryPageInput,
  maxBufferBytes: number,
  maxLines = MAX_TERMINAL_BUFFER_LINES,
): TerminalOutputState {
  const detached = current.detached;
  if (detached === null || page.offset !== detached.end) return current;
  const pageChunks = makeChunks(page.data, current.nextOffset, {
    exact: true,
    serverEnd: page.end,
  });
  let nextOffset = current.nextOffset + page.data.length;
  const appended = [...pageChunks];
  let stillDetached: TerminalDetachedWindow | null = { ...detached, end: page.end };
  if (!page.newerHistory && detached.bufferedFrom <= page.end) {
    for (const entry of detached.buffered) {
      if (entry.end <= page.end) continue;
      const chunks = makeChunks(entry.data, nextOffset, { exact: false, serverEnd: entry.end });
      appended.push(...chunks);
      nextOffset += entry.data.length;
    }
    stillDetached = null;
  }
  const window = windowOf(current, [...current.chunks, ...appended]);
  trimFront(window, maxBufferBytes, maxLines);
  const dropped = window.chunks[0]?.startOffset ?? nextOffset;
  const firstBefore = current.chunks[0]?.startOffset ?? current.nextOffset;
  if (dropped === firstBefore) {
    // Nothing was dropped, so readers append.
    return fromWindow(current, window, { nextOffset, detached: stillDetached });
  }
  const resetVersion = current.resetVersion + 1;
  return {
    ...fromWindow(current, { ...window, chunks: renumber(window.chunks) }, {}),
    nextOffset: nextOffset - dropped,
    resetVersion,
    detached: stillDetached,
    anchor: { resetVersion, split: current.nextOffset - dropped, keep: "end" },
  };
}

/** Replaces a detached window with the newest page, and follows the live output again. */
function showLatestOutput(
  current: TerminalOutputState,
  page: TerminalHistoryPageInput,
  maxBufferBytes: number,
  maxLines = MAX_TERMINAL_BUFFER_LINES,
): TerminalOutputState {
  const detached = current.detached;
  if (detached === null) return current;
  const reset = resetOutput(
    current,
    page.data,
    maxBufferBytes,
    { offset: page.offset, end: page.end, older: page.olderHistory },
    maxLines,
  );
  if (page.newerHistory || detached.bufferedFrom > page.end) {
    return { ...reset, detached: { ...detached, end: page.end } };
  }
  return detached.buffered.reduce(
    (state, entry) =>
      entry.end <= page.end
        ? state
        : appendOutput(state, entry.data, maxBufferBytes, entry.end, maxLines),
    reset,
  );
}

export function terminalOutputText(output: TerminalOutputState): string {
  return output.chunks.map((chunk) => chunk.data).join("");
}

export function readTerminalOutputUpdate(
  output: TerminalOutputState,
  cursor: TerminalOutputCursor,
): TerminalOutputUpdate {
  const nextCursor = {
    generation: output.generation,
    resetVersion: output.resetVersion,
    offset: output.nextOffset,
  };
  const firstChunk = output.chunks[0];
  if (
    cursor.generation !== output.generation ||
    cursor.resetVersion !== output.resetVersion ||
    cursor.offset < (firstChunk?.startOffset ?? output.nextOffset)
  ) {
    const anchor = output.anchor;
    return {
      type: "reset",
      data: terminalOutputText(output),
      cursor: nextCursor,
      // Only a reader that had everything before this reset can keep its place.
      anchor:
        anchor !== null &&
        anchor.resetVersion === output.resetVersion &&
        cursor.generation === output.generation &&
        cursor.resetVersion === output.resetVersion - 1
          ? { split: anchor.split, keep: anchor.keep }
          : null,
    };
  }

  // Appends and compaction preserve offset order, so unread chunks form a suffix.
  let firstUnread = output.chunks.length;
  while (firstUnread > 0) {
    const chunk = output.chunks[firstUnread - 1]!;
    if (!(chunk.startOffset + chunk.data.length > cursor.offset)) break;
    firstUnread -= 1;
  }
  const appended = output.chunks.slice(firstUnread);
  if (appended.length === 0) {
    return { type: "none", cursor: nextCursor };
  }
  return {
    type: "append",
    data: appended
      .map((chunk) => chunk.data.slice(Math.max(0, cursor.offset - chunk.startOffset)))
      .join(""),
    cursor: nextCursor,
  };
}

export { appendNewerOutput, appendOutput, prependOutput, resetOutput, showLatestOutput };
