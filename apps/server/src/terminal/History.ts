// Offsets count UTF-8 bytes appended over a history's life, so they keep naming the same
// text as output is trimmed, and minus `fileStart` they are positions in its file. Memory
// holds the newest text; for older, "spilled" text only sizes stay, and the file has it.
export const DEFAULT_HISTORY_BYTE_LIMIT = 256 * 1024 * 1024;
const MAX_HISTORY_CHUNK_LENGTH = 16 * 1024;
const SPILLED_SEGMENT_BYTES = 64 * 1024;
// A history file is rewritten once its trimmed prefix is at least as large as the retained
// history, so total writes stay within twice the output.
const MIN_HISTORY_COMPACTION_BYTES = 4 * 1024 * 1024;

interface Chunk {
  data: string;
  byteLength: number;
  lineBreaks: number;
}

interface Segment {
  bytes: number;
  lineBreaks: number;
}

/** What the history file holds: this history's bytes from `fileStart` to `end`. */
export interface PersistedHistoryFile {
  readonly generation: number;
  readonly fileStart: number;
  readonly end: number;
  /** The file may not match memory past the spilled part, so the next write rewrites it. */
  readonly dirty?: boolean;
}

const utf8Width = (codePoint: number) =>
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;

/** The UTF-16 index where `bytes` UTF-8 bytes of `text` end, at a code point boundary. */
function utf16IndexAtByte(text: string, bytes: number): number {
  let index = 0;
  let consumed = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index)!;
    const width = utf8Width(codePoint);
    if (consumed + width > bytes) break;
    consumed += width;
    index += codePoint <= 0xffff ? 1 : 2;
  }
  return index;
}

const countLineBreaks = (data: string) => {
  let lineBreaks = 0;
  for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
    lineBreaks += 1;
  }
  return lineBreaks;
};

export class BoundedTerminalHistory {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private chunks: Array<Chunk | undefined> = [];
  private start = 0;
  private byteLength = 0;
  private lineBreaks = 0;
  private spilled: Array<Segment | undefined> = [];
  private spilledStart = 0;
  private spilledBytes = 0;
  private spilledLines = 0;
  private end = 0;
  private generation = 0;
  // Reading the old string's tail on each append can force chunk concatenation.
  private lastCodeUnit: number | undefined;
  private cachedValue: string | null = "";
  persisted: PersistedHistoryFile | null = null;

  constructor(maxLines: number, initial: string, maxBytes = DEFAULT_HISTORY_BYTE_LIMIT) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.append(initial);
  }

  /**
   * A history read back from a file: `segments` describe the file's bytes from `start` that
   * stay on disk, and `tail` is the text after them.
   */
  static restored(
    maxLines: number,
    maxBytes: number,
    start: number,
    segments: ReadonlyArray<Segment>,
    tail: string,
  ): BoundedTerminalHistory {
    const history = new BoundedTerminalHistory(maxLines, "", maxBytes);
    history.end = start;
    for (const segment of segments) {
      if (segment.bytes === 0) continue;
      history.spilled.push({ ...segment });
      history.spilledBytes += segment.bytes;
      history.spilledLines += segment.lineBreaks;
      history.end += segment.bytes;
    }
    history.trim();
    history.append(tail);
    return history;
  }

  get startOffset(): number {
    return this.end - this.spilledBytes - this.byteLength;
  }

  /** Where the text held in memory starts; older text is only in the file. */
  get memoryStart(): number {
    return this.end - this.byteLength;
  }

  get endOffset(): number {
    return this.end;
  }

  get bytes(): number {
    return this.spilledBytes + this.byteLength;
  }

  get memoryBytes(): number {
    return this.byteLength;
  }

  /** Changes whenever retained text is dropped without trimming, as by `clear`. */
  get clearGeneration(): number {
    return this.generation;
  }

  get endsInHighSurrogate(): boolean {
    const last = this.lastCodeUnit;
    return last !== undefined && last >= 0xd800 && last <= 0xdbff;
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.cachedValue = null;
    if (this.maxBytes <= 0 || this.maxLines <= 0) {
      this.clearRetained();
      this.end += Buffer.byteLength(text);
      if (this.maxBytes > 0 && text.endsWith("\n")) {
        this.end -= 1;
        this.appendChunk("\n");
      }
      return;
    }

    let offset = 0;
    const previous = this.chunks.at(-1);
    const lastCode = this.lastCodeUnit;
    const firstCode = text.charCodeAt(0);
    if (
      previous &&
      lastCode !== undefined &&
      lastCode >= 0xd800 &&
      lastCode <= 0xdbff &&
      firstCode >= 0xdc00 &&
      firstCode <= 0xdfff
    ) {
      // Joining a split surrogate changes its UTF-8 size from 3 to 4 bytes.
      previous.data += text[0];
      previous.byteLength += 1;
      this.byteLength += 1;
      this.end += 1;
      this.lastCodeUnit = firstCode;
      offset = 1;
      this.trim();
    }

    while (offset < text.length) {
      let end = Math.min(offset + MAX_HISTORY_CHUNK_LENGTH, text.length);
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      const data = text.slice(offset, end);
      // Detach small chunks from large input strings so evicted prefixes can be collected.
      this.appendChunk(
        text.length > MAX_HISTORY_CHUNK_LENGTH
          ? Buffer.from(data, "utf16le").toString("utf16le")
          : data,
      );
      this.trim();
      offset = end;
    }
  }

  private appendChunk(data: string): void {
    const byteLength = Buffer.byteLength(data);
    const lineBreaks = countLineBreaks(data);
    const previous = this.chunks.at(-1);
    if (previous && previous.data.length + data.length <= MAX_HISTORY_CHUNK_LENGTH) {
      previous.data += data;
      previous.byteLength += byteLength;
      previous.lineBreaks += lineBreaks;
    } else {
      this.chunks.push({ data, byteLength, lineBreaks });
    }
    this.byteLength += byteLength;
    this.lineBreaks += lineBreaks;
    this.end += byteLength;
    this.lastCodeUnit = data.charCodeAt(data.length - 1);
    this.cachedValue = null;
  }

  private discardChunk(): void {
    const first = this.chunks[this.start]!;
    this.byteLength -= first.byteLength;
    this.lineBreaks -= first.lineBreaks;
    this.chunks[this.start++] = undefined;
    this.cachedValue = null;
  }

  private trimChunk(offset: number, byteLength: number, lineBreaks: number): void {
    const first = this.chunks[this.start]!;
    if (offset === first.data.length) {
      this.discardChunk();
      return;
    }
    first.data = first.data.slice(offset);
    first.byteLength -= byteLength;
    first.lineBreaks -= lineBreaks;
    this.byteLength -= byteLength;
    this.lineBreaks -= lineBreaks;
    this.cachedValue = null;
  }

  private discardSegment(): void {
    const first = this.spilled[this.spilledStart]!;
    this.spilledBytes -= first.bytes;
    this.spilledLines -= first.lineBreaks;
    this.spilled[this.spilledStart++] = undefined;
    if (this.spilledStart === this.spilled.length) {
      this.spilled = [];
      this.spilledStart = 0;
    } else if (this.spilledStart > 2_048 && this.spilledStart * 2 >= this.spilled.length) {
      this.spilled = this.spilled.slice(this.spilledStart);
      this.spilledStart = 0;
    }
  }

  private linesOver(): number {
    const trailingNewline = this.lastCodeUnit === 10;
    return (
      this.spilledLines +
      this.lineBreaks +
      (trailingNewline || this.byteLength === 0 ? 0 : 1) -
      this.maxLines
    );
  }

  private trim(): void {
    // Text on disk is dropped a whole segment at a time, so a limit can keep slightly less.
    while (
      this.spilledBytes > 0 &&
      (this.linesOver() > 0 || this.spilledBytes + this.byteLength > this.maxBytes)
    ) {
      this.discardSegment();
    }

    let linesToDrop = this.linesOver();
    while (linesToDrop > 0 && this.start < this.chunks.length) {
      const first = this.chunks[this.start]!;
      if (first.lineBreaks < linesToDrop) {
        linesToDrop -= first.lineBreaks;
        this.discardChunk();
        continue;
      }
      let offset = 0;
      for (let line = 0; line < linesToDrop; line += 1) {
        offset = first.data.indexOf("\n", offset) + 1;
      }
      this.trimChunk(offset, Buffer.byteLength(first.data.slice(0, offset)), linesToDrop);
      linesToDrop = 0;
    }

    while (this.byteLength > this.maxBytes) {
      const first = this.chunks[this.start]!;
      const bytesToDrop = this.byteLength - this.maxBytes;
      if (first.byteLength <= bytesToDrop) {
        this.discardChunk();
        continue;
      }
      if (first.byteLength === first.data.length && first.lineBreaks === 0) {
        this.trimChunk(bytesToDrop, bytesToDrop, 0);
        continue;
      }
      let offset = 0;
      let bytes = 0;
      let lineBreaks = 0;
      while (bytes < bytesToDrop) {
        const codePoint = first.data.codePointAt(offset)!;
        bytes += utf8Width(codePoint);
        offset += codePoint <= 0xffff ? 1 : 2;
        if (codePoint === 10) lineBreaks += 1;
      }
      this.trimChunk(offset, bytes, lineBreaks);
    }
    this.compactChunks();
  }

  private compactChunks(): void {
    if (
      this.start === this.chunks.length ||
      (this.start > 2_048 && this.start * 2 >= this.chunks.length)
    ) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
      if (this.chunks.length === 0) this.lastCodeUnit = undefined;
    }
  }

  /**
   * Releases the oldest text held in memory, down to about `targetBytes`, keeping only its
   * size. Only text the file already holds is released.
   */
  spill(targetBytes: number): void {
    const persisted = this.persisted;
    if (persisted === null || persisted.generation !== this.generation || persisted.dirty) return;
    let chunkEnd = this.memoryStart;
    while (this.byteLength > targetBytes && this.start < this.chunks.length - 1) {
      const first = this.chunks[this.start]!;
      chunkEnd += first.byteLength;
      if (chunkEnd > persisted.end) break;
      const last = this.spilled.at(-1);
      if (
        last !== undefined &&
        this.spilled.length > this.spilledStart &&
        last.bytes < SPILLED_SEGMENT_BYTES
      ) {
        last.bytes += first.byteLength;
        last.lineBreaks += first.lineBreaks;
      } else {
        this.spilled.push({ bytes: first.byteLength, lineBreaks: first.lineBreaks });
      }
      this.spilledBytes += first.byteLength;
      this.spilledLines += first.lineBreaks;
      this.discardChunk();
    }
    this.compactChunks();
  }

  private clearRetained(): void {
    this.chunks = [];
    this.start = 0;
    this.byteLength = 0;
    this.lineBreaks = 0;
    this.spilled = [];
    this.spilledStart = 0;
    this.spilledBytes = 0;
    this.spilledLines = 0;
    this.lastCodeUnit = undefined;
    this.cachedValue = "";
  }

  clear(): void {
    this.clearRetained();
    this.generation += 1;
  }

  /** The text held in memory. */
  value(): string {
    if (this.cachedValue !== null) return this.cachedValue;
    this.cachedValue = this.chunks
      .slice(this.start)
      .map((chunk) => chunk!.data)
      .join("");
    return this.cachedValue;
  }

  /** The text from `from` to `to`, which must both lie in memory. */
  memoryText(from: number, to: number = this.end): string {
    const lower = Math.max(from, this.memoryStart);
    const upper = Math.min(to, this.end);
    if (upper <= lower) return "";
    const pieces: string[] = [];
    let chunkStart = this.memoryStart;
    for (let index = this.start; index < this.chunks.length && chunkStart < upper; index += 1) {
      const chunk = this.chunks[index]!;
      const chunkEnd = chunkStart + chunk.byteLength;
      if (chunkEnd > lower) {
        const begin = lower > chunkStart ? utf16IndexAtByte(chunk.data, lower - chunkStart) : 0;
        const finish =
          upper < chunkEnd ? utf16IndexAtByte(chunk.data, upper - chunkStart) : chunk.data.length;
        pieces.push(
          begin === 0 && finish === chunk.data.length
            ? chunk.data
            : chunk.data.slice(begin, finish),
        );
      }
      chunkStart = chunkEnd;
    }
    return pieces.join("");
  }

  /** The first character boundary at or after `offset` in memory. */
  alignForward(offset: number): number {
    if (offset <= this.memoryStart) return this.memoryStart;
    if (offset >= this.end) return this.end;
    let chunkStart = this.memoryStart;
    for (let index = this.start; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index]!;
      if (chunkStart + chunk.byteLength > offset) {
        let consumed = 0;
        for (let at = 0; consumed < offset - chunkStart;) {
          const codePoint = chunk.data.codePointAt(at)!;
          consumed += utf8Width(codePoint);
          at += codePoint <= 0xffff ? 1 : 2;
        }
        return chunkStart + consumed;
      }
      chunkStart += chunk.byteLength;
    }
    return this.end;
  }

  /** Whether the text just before `offset` is a line break, when memory holds it. */
  lineBreakBefore(offset: number): boolean | undefined {
    if (offset <= this.memoryStart || offset > this.end) return undefined;
    return this.memoryText(offset - 1, offset) === "\n";
  }
}

/** A page of output: its text, where it starts and ends, and whether more lies either side. */
export interface HistoryPage {
  readonly data: string;
  readonly offset: number;
  readonly end: number;
  readonly olderHistory: boolean;
  readonly newerHistory: boolean;
}

/**
 * Trims a page read before `end` so it starts at a line (unless it starts the history),
 * since a page cut inside a line would draw that line's tail as if it were whole.
 */
export function startPageAtLine(
  data: string,
  offset: number,
  historyStart: number,
  lineBreakBefore: boolean,
): { readonly data: string; readonly offset: number } {
  if (offset <= historyStart || lineBreakBefore) return { data, offset };
  const lineStart = data.indexOf("\n") + 1;
  if (lineStart <= 0 || lineStart >= data.length) return { data, offset };
  return {
    data: data.slice(lineStart),
    offset: offset + Buffer.byteLength(data.slice(0, lineStart)),
  };
}

export type HistoryFileWrite =
  | {
      readonly append: true;
      readonly text: string;
      readonly persisted: PersistedHistoryFile;
    }
  | {
      readonly append: false;
      /** File bytes to copy into the new file first, from the current file. */
      readonly copy: { readonly from: number; readonly to: number } | null;
      readonly text: string;
      readonly persisted: PersistedHistoryFile;
    };

/**
 * What to write so the history file holds `history`: the text it lacks, appended; or a new
 * file, written aside and renamed over the old one, when the history was cleared, the file
 * is unknown or dirty, or its trimmed prefix has outgrown the retained text.
 */
export function planHistoryFileWrite(
  history: BoundedTerminalHistory,
  minCompactionBytes = MIN_HISTORY_COMPACTION_BYTES,
): HistoryFileWrite {
  const generation = history.clearGeneration;
  // A trailing high surrogate is written with its pair, or encoding would replace it.
  const end = history.endsInHighSurrogate ? history.endOffset - 3 : history.endOffset;
  const persisted = history.persisted;
  const current = persisted !== null && persisted.generation === generation ? persisted : null;
  if (current !== null && !current.dirty && current.end >= history.memoryStart) {
    const trimmedBytes = history.startOffset - current.fileStart;
    if (trimmedBytes < Math.max(minCompactionBytes, history.bytes)) {
      return {
        append: true,
        text: current.end < end ? history.memoryText(current.end, end) : "",
        persisted: { generation, fileStart: current.fileStart, end: Math.max(end, current.end) },
      };
    }
  }
  const start = history.startOffset;
  const memoryStart = history.memoryStart;
  return {
    append: false,
    // Text released from memory is only in the file; it was written before it was released.
    copy:
      current !== null && memoryStart > start
        ? { from: start - current.fileStart, to: memoryStart - current.fileStart }
        : null,
    text: history.memoryText(memoryStart, end),
    persisted: { generation, fileStart: start, end: Math.max(end, memoryStart) },
  };
}

/**
 * Releases the oldest in-memory output of the histories holding the most, down to `floor`
 * each, until all together fit `budget`. Released output stays readable from the files.
 */
export function releaseHistoryMemory(
  histories: Iterable<BoundedTerminalHistory>,
  budget: number,
  floor: number,
): void {
  const all = [...histories];
  let total = all.reduce((sum, history) => sum + history.memoryBytes, 0);
  if (total <= budget) return;
  for (const history of all.sort((left, right) => right.memoryBytes - left.memoryBytes)) {
    const before = history.memoryBytes;
    history.spill(floor);
    total -= before - history.memoryBytes;
    if (total <= budget) return;
  }
}

/**
 * Where to read history `[from, to)` in a file holding it from `fileStart`, taken under
 * the file's lock: a rewrite can have trimmed the history or moved the file's start since
 * the range was chosen. Reads one byte more in front, to tell whether the range starts a
 * line. Null when the file holds none of it.
 */
export function historyFileRead(
  from: number,
  to: number,
  historyStart: number,
  fileStart: number,
): {
  readonly from: number;
  readonly readFrom: number;
  readonly position: number;
  readonly length: number;
} | null {
  const lower = Math.max(from, historyStart, fileStart);
  if (to <= lower) return null;
  const readFrom = Math.max(fileStart, lower - 1);
  return { from: lower, readFrom, position: readFrom - fileStart, length: to - readFrom };
}
