import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

/** The SDK consumes these stdout lines itself; they never reach the adapter. */
const SDK_INTERNAL_TYPES = new Set([
  "control_request",
  "control_response",
  "control_cancel_request",
  "keep_alive",
  "transcript_mirror",
]);

const POLL_INTERVAL = "250 millis";

export type ClaudeOutputMessage = Record<string, unknown> & { readonly type: string };

function parseClaudeOutputLine(line: string): ClaudeOutputMessage | undefined {
  if (line.trim().length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const type = (value as { readonly type?: unknown }).type;
  if (typeof type !== "string" || SDK_INTERNAL_TYPES.has(type)) return undefined;
  return value as ClaudeOutputMessage;
}

/**
 * Yields the lines after `resumeAfterUuid` (all lines if it is gone), first
 * resending tool calls still waiting for their result so their results have a
 * call. Stream events of a message whose start came earlier are dropped; the
 * complete assistant message that follows carries their text.
 */
export class ClaudeOutputFollower {
  private remainder = "";
  private resumed: boolean;
  private midMessage = true;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly resumeAfterUuid: string | undefined;
  private readonly openToolUses = new Map<string, ClaudeOutputMessage>();

  constructor(resumeAfterUuid: string | undefined) {
    this.resumeAfterUuid = resumeAfterUuid;
    this.resumed = resumeAfterUuid === undefined;
  }

  /** The first chunk must be the whole file so the resume point can be found. */
  pushInitial(bytes: Uint8Array): ReadonlyArray<ClaudeOutputMessage> {
    const text = this.decoder.decode(bytes, { stream: true });
    if (!this.resumed && !text.includes(`"${this.resumeAfterUuid}"`)) this.resumed = true;
    return this.pushText(text);
  }

  push(bytes: Uint8Array): ReadonlyArray<ClaudeOutputMessage> {
    return this.pushText(this.decoder.decode(bytes, { stream: true }));
  }

  /** A final line without its newline is still a whole message once the writer is gone. */
  flush(): ReadonlyArray<ClaudeOutputMessage> {
    return this.pushText(`${this.decoder.decode()}\n`);
  }

  private pushText(text: string): ReadonlyArray<ClaudeOutputMessage> {
    const lines = (this.remainder + text).split("\n");
    this.remainder = lines.pop() ?? "";
    const messages: Array<ClaudeOutputMessage> = [];
    for (const line of lines) {
      const message = parseClaudeOutputLine(line);
      if (message === undefined) continue;
      if (!this.resumed) {
        this.trackOpenToolUses(message);
        if (message.uuid === this.resumeAfterUuid) {
          this.resumed = true;
          messages.push(...this.takeOpenToolUses());
        }
        continue;
      }
      if (message.type === "stream_event") {
        const event = message.event as { readonly type?: unknown } | undefined;
        if (event?.type === "message_start") this.midMessage = false;
        if (this.midMessage) continue;
      } else if (message.type === "assistant") {
        this.midMessage = false;
      }
      messages.push(message);
    }
    return messages;
  }

  private trackOpenToolUses(message: ClaudeOutputMessage) {
    if (message.parent_tool_use_id != null) return;
    for (const block of contentBlocks(message)) {
      if (message.type === "assistant" && block.type === "tool_use" && typeof block.id === "string")
        this.openToolUses.set(block.id, message);
      if (message.type === "user" && block.type === "tool_result")
        this.openToolUses.delete(String(block.tool_use_id));
    }
  }

  /** Each message once, with only its unanswered tool calls. */
  private takeOpenToolUses(): ReadonlyArray<ClaudeOutputMessage> {
    const byMessage = new Map<ClaudeOutputMessage, Set<string>>();
    for (const [id, message] of this.openToolUses) {
      byMessage.set(message, (byMessage.get(message) ?? new Set()).add(id));
    }
    this.openToolUses.clear();
    return [...byMessage].map(([message, ids]) => ({
      ...message,
      message: {
        ...(message.message as Record<string, unknown>),
        content: contentBlocks(message).filter(
          (block) => block.type === "tool_use" && ids.has(String(block.id)),
        ),
      },
    }));
  }
}

function contentBlocks(message: ClaudeOutputMessage): ReadonlyArray<Record<string, unknown>> {
  const content = (message.message as { readonly content?: unknown } | undefined)?.content;
  return Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
      )
    : [];
}

/** Whether replaying the file would finish the turn the CLI was running. */
export function claudeOutputCompletesTurn(bytes: Uint8Array, resumeAfterUuid: string | undefined) {
  const follower = new ClaudeOutputFollower(resumeAfterUuid);
  return [...follower.pushInitial(bytes), ...follower.flush()].some(
    (message) => message.type === "result" && message.parent_tool_use_id == null,
  );
}

/**
 * Follows a detached CLI's stdout file from the resume point until the CLI has
 * exited and every line it wrote has been read.
 */
export const followClaudeDetachedOutput = (input: {
  readonly filePath: string;
  readonly resumeAfterUuid: string | undefined;
  readonly alive: Effect.Effect<boolean>;
}): Stream.Stream<ClaudeOutputMessage, never, FileSystem.FileSystem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const follower = new ClaudeOutputFollower(input.resumeAfterUuid);
      const readFrom = (offset: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const size = Number((yield* fileSystem.stat(input.filePath)).size);
            if (size <= offset) return new Uint8Array();
            const handle = yield* fileSystem.open(input.filePath, { flag: "r" });
            yield* handle.seek(BigInt(offset), "start");
            return Option.getOrElse(yield* handle.readAlloc(size - offset), () => new Uint8Array());
          }),
        ).pipe(Effect.orElseSucceed(() => new Uint8Array()));
      const initial = yield* readFrom(0);
      const first = follower.pushInitial(initial);
      return Stream.concat(
        Stream.fromIterable(first),
        Stream.paginate<number, ClaudeOutputMessage>(initial.byteLength, (previous) =>
          Effect.gen(function* () {
            // Read after checking liveness so the last lines of an exited CLI are not missed.
            const alive = yield* input.alive;
            const bytes = yield* readFrom(previous);
            const offset = previous + bytes.byteLength;
            if (bytes.byteLength > 0) {
              return [follower.push(bytes), Option.some(offset)] as const;
            }
            if (!alive) return [follower.flush(), Option.none()] as const;
            yield* Effect.sleep(POLL_INTERVAL);
            return [[], Option.some(offset)] as const;
          }),
        ),
      );
    }),
  );
