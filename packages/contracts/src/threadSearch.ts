import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

/** Longer queries are cut to this before they are sent. */
export const THREAD_SEARCH_QUERY_MAX_LENGTH = 200;

/** How many threads later pages can leave out, and so how many a search can list. */
export const THREAD_SEARCH_MAX_EXCLUDED_THREADS = 2_000;

/** Where the next page of message matches starts: messages older than `before`. */
export const OrchestrationThreadSearchCursor = Schema.Struct({
  before: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type OrchestrationThreadSearchCursor = typeof OrchestrationThreadSearchCursor.Type;

// The server's SQLite reader is shared. Each page bounds the messages it reads and the
// threads it returns, so a search cannot monopolize that connection or a client.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(
    Schema.isMinLength(2),
    Schema.isMaxLength(THREAD_SEARCH_QUERY_MAX_LENGTH),
  ),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  /** The previous page's `cursor`, for the next page. */
  cursor: Schema.optionalKey(OrchestrationThreadSearchCursor),
  /** Threads earlier pages of this search returned, so later pages leave them out. */
  excludedThreadIds: Schema.optionalKey(
    Schema.Array(ThreadId).check(Schema.isMaxLength(THREAD_SEARCH_MAX_EXCLUDED_THREADS)),
  ),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
  /**
   * How well the message matches: 1 for whole words, 0.8 when a word only
   * starts one, 0.3 when one only appears inside words, 0.25 more when the
   * words are written together as typed, else 0.1 more when they are near.
   * Older servers omit it.
   */
  quality: Schema.optionalKey(Schema.Finite),
  /** How many of the thread's newest messages match. Older servers omit it. */
  hits: Schema.optionalKey(Schema.Int),
  /** The message the snippet is from. Older servers omit it. */
  messageId: Schema.optionalKey(MessageId),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
  /** Present when older messages may hold more matches; pass it back for the next page. */
  cursor: Schema.optionalKey(OrchestrationThreadSearchCursor),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedError<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
