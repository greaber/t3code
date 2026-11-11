export interface TerminalOutputChunk {
  readonly startOffset: number;
  readonly data: string;
  readonly byteLength: number;
}

export interface TerminalOutputState {
  readonly generation: number;
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly retainedBytes: number;
  readonly resetVersion: number;
  readonly nextOffset: number;
  /**
   * The server's offset of the first retained character, for paging in older output.
   * Null when unknown: an older server, or live output pushed out every server page.
   */
  readonly historyOffset: number | null;
  /** How many leading characters are server history, whose offsets are known. */
  readonly historyLength: number;
  /** The server keeps output before `historyOffset`. */
  readonly olderHistory: boolean;
  /** The last reset only added older output in front of what was there. */
  readonly prepended: boolean;
}

/** Where a server snapshot or page of history starts. */
export interface TerminalHistoryAnchor {
  readonly offset: number;
  readonly older: boolean;
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
      /** Only older output was added before what the reader had, so it can keep its place. */
      readonly prepended: boolean;
    }
  | {
      readonly type: "append";
      readonly cursor: TerminalOutputCursor;
      readonly data: string;
    };

const DEFAULT_TERMINAL_CHUNK_BYTES = 16 * 1024;
// Enough 16 KiB chunks for the default buffer; compaction keeps chunks near that size.
const MAX_TERMINAL_OUTPUT_CHUNKS = 2_048;
const textEncoder = new TextEncoder();
// A BOM at a retained chunk boundary is terminal data, not an encoding marker.
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

export const EMPTY_TERMINAL_OUTPUT_STATE = Object.freeze<TerminalOutputState>({
  generation: 0,
  chunks: Object.freeze([]),
  retainedBytes: 0,
  resetVersion: 0,
  nextOffset: 0,
  historyOffset: null,
  historyLength: 0,
  olderHistory: false,
  prepended: false,
});

interface Utf8Chunk {
  readonly data: string;
  readonly byteLength: number;
}

function splitStringByUtf8Bytes(data: string, maxBytes: number): ReadonlyArray<Utf8Chunk> {
  if (data.length === 0) return [];

  const encoded = textEncoder.encode(data);
  if (encoded.byteLength <= maxBytes) {
    return [{ data, byteLength: encoded.byteLength }];
  }

  const chunks: Utf8Chunk[] = [];
  let offset = 0;
  while (offset < encoded.byteLength) {
    let end = Math.min(offset + maxBytes, encoded.byteLength);
    while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }
    // A degenerate budget smaller than one code point still has to advance:
    // include the whole code point rather than looping forever.
    if (end === offset) {
      end = Math.min(offset + maxBytes, encoded.byteLength);
      while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
        end += 1;
      }
    }
    const bytes = encoded.subarray(offset, end);
    chunks.push({ data: textDecoder.decode(bytes), byteLength: bytes.byteLength });
    offset = end;
  }

  return chunks;
}

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

function splitOutputChunks(
  data: string,
  firstOffset: number,
  maxChunkBytes = DEFAULT_TERMINAL_CHUNK_BYTES,
): {
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly nextOffset: number;
  readonly byteLength: number;
} {
  const split = splitStringByUtf8Bytes(data, maxChunkBytes);
  let byteLength = 0;
  let nextOffset = firstOffset;
  const chunks = split.map((chunk) => {
    byteLength += chunk.byteLength;
    const startOffset = nextOffset;
    nextOffset += chunk.data.length;
    return {
      startOffset,
      data: chunk.data,
      byteLength: chunk.byteLength,
    };
  });

  return {
    chunks,
    nextOffset,
    byteLength,
  };
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
      };
    } else {
      compacted.push(chunk);
    }
  }
  return compacted;
}

function trimOutputChunkStart(
  chunk: TerminalOutputChunk,
  bytesToDrop: number,
): TerminalOutputChunk {
  let offset = 0;
  let droppedBytes = 0;
  while (droppedBytes < bytesToDrop && offset < chunk.data.length) {
    const codepoint = chunk.data.codePointAt(offset)!;
    droppedBytes += codepoint <= 0x7f ? 1 : codepoint <= 0x7ff ? 2 : codepoint <= 0xffff ? 3 : 4;
    offset += codepoint <= 0xffff ? 1 : 2;
  }
  return {
    ...chunk,
    startOffset: chunk.startOffset + offset,
    data: chunk.data.slice(offset),
    byteLength: chunk.byteLength - droppedBytes,
  };
}

function appendOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
): TerminalOutputState {
  if (data.length === 0) return current;
  if (maxBufferBytes <= 0) {
    return {
      ...current,
      chunks: [],
      retainedBytes: 0,
      resetVersion: current.resetVersion + 1,
      nextOffset: current.nextOffset + data.length,
      historyOffset: null,
      historyLength: 0,
      olderHistory: false,
      prepended: false,
    };
  }
  const appended = splitOutputChunks(
    data,
    current.nextOffset,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );

  const chunks = [...current.chunks, ...appended.chunks];
  let retainedBytes = current.retainedBytes + appended.byteLength;
  let firstRetainedIndex = 0;
  while (retainedBytes > maxBufferBytes && firstRetainedIndex < chunks.length) {
    const first = chunks[firstRetainedIndex]!;
    const bytesToDrop = retainedBytes - maxBufferBytes;
    if (bytesToDrop < first.byteLength) {
      const trimmed = trimOutputChunkStart(first, bytesToDrop);
      retainedBytes -= first.byteLength - trimmed.byteLength;
      if (trimmed.byteLength > 0) {
        chunks[firstRetainedIndex] = trimmed;
      } else {
        firstRetainedIndex += 1;
      }
      break;
    }
    retainedBytes -= first.byteLength;
    firstRetainedIndex += 1;
  }

  let retainedChunks = firstRetainedIndex === 0 ? chunks : chunks.slice(firstRetainedIndex);
  if (retainedChunks.length > MAX_TERMINAL_OUTPUT_CHUNKS) {
    retainedChunks = compactRetainedChunks(retainedChunks);
    const excessChunks = retainedChunks.length - MAX_TERMINAL_OUTPUT_CHUNKS;
    if (excessChunks > 0) {
      for (const chunk of retainedChunks.slice(0, excessChunks)) {
        retainedBytes -= chunk.byteLength;
      }
      retainedChunks = retainedChunks.slice(excessChunks);
    }
  }

  const dropped =
    (retainedChunks[0]?.startOffset ?? appended.nextOffset) -
    (current.chunks[0]?.startOffset ?? current.nextOffset);
  return {
    ...current,
    chunks: retainedChunks,
    retainedBytes,
    nextOffset: appended.nextOffset,
    ...dropHistory(current, dropped),
  };
}

function dropHistory(
  current: TerminalOutputState,
  dropped: number,
): Pick<TerminalOutputState, "historyOffset" | "historyLength" | "olderHistory"> {
  if (dropped === 0) {
    const { historyOffset, historyLength, olderHistory } = current;
    return { historyOffset, historyLength, olderHistory };
  }
  // Live output differs from what the server keeps, so offsets end with its history.
  if (current.historyOffset === null || dropped > current.historyLength) {
    return { historyOffset: null, historyLength: 0, olderHistory: false };
  }
  return {
    historyOffset: current.historyOffset + dropped,
    historyLength: current.historyLength - dropped,
    olderHistory: true,
  };
}

function resetOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
  history?: TerminalHistoryAnchor,
): TerminalOutputState {
  const retained = trimBufferToBytes(data, maxBufferBytes);
  const reset = splitOutputChunks(
    retained,
    0,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );
  const trimmed = data.length - retained.length;
  return {
    generation: current.generation,
    chunks: reset.chunks,
    retainedBytes: reset.byteLength,
    resetVersion: current.resetVersion + 1,
    nextOffset: reset.nextOffset,
    historyOffset: history === undefined ? null : history.offset + trimmed,
    historyLength: history === undefined ? 0 : retained.length,
    olderHistory: history !== undefined && (history.older || trimmed > 0),
    prepended: false,
  };
}

/** Whether the server keeps older output that fits in front of what is retained. */
export function canLoadOlderTerminalOutput(
  output: TerminalOutputState,
  maxBufferBytes: number,
): boolean {
  return (
    output.olderHistory && output.historyOffset !== null && output.retainedBytes < maxBufferBytes
  );
}

/**
 * Puts a page of older server output in front of the retained output, keeping only what
 * fits. A page that does not end where the retained history starts is stale and ignored.
 */
function prependOutput(
  current: TerminalOutputState,
  page: { readonly data: string; readonly offset: number; readonly olderHistory: boolean },
  maxBufferBytes: number,
): TerminalOutputState {
  if (current.historyOffset === null || page.offset + page.data.length !== current.historyOffset) {
    return current;
  }
  const fitted = trimBufferToBytes(page.data, maxBufferBytes - current.retainedBytes);
  const offset = page.offset + page.data.length - fitted.length;
  const olderHistory = page.olderHistory || offset > page.offset;
  if (fitted.length === 0) {
    return olderHistory === current.olderHistory ? current : { ...current, olderHistory };
  }
  const reset = splitOutputChunks(
    fitted + terminalOutputText(current),
    0,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );
  return {
    generation: current.generation,
    chunks: reset.chunks,
    retainedBytes: reset.byteLength,
    resetVersion: current.resetVersion + 1,
    nextOffset: reset.nextOffset,
    historyOffset: offset,
    historyLength: current.historyLength + fitted.length,
    olderHistory,
    prepended: true,
  };
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
    return {
      type: "reset",
      data: terminalOutputText(output),
      cursor: nextCursor,
      prepended:
        output.prepended &&
        cursor.generation === output.generation &&
        cursor.resetVersion === output.resetVersion - 1,
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

export { appendOutput, prependOutput, resetOutput };
