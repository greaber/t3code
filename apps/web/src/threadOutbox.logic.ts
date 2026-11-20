import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { shouldRetryThreadOutboxDelivery } from "@t3tools/client-runtime/errors";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** A message written while its environment was unreachable, sent once it connects. */
export const OutboxMessage = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  // Reused on every attempt, so a retry after an unanswered send cannot add a second turn.
  commandId: CommandId,
  /** What the provider receives. */
  text: Schema.String,
  /** What the user wrote, shown in the thread and restored to the composer for editing. */
  draftText: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
  /** Why the server refused it; a refused message waits for the user. */
  failure: Schema.NullOr(Schema.String),
});
export type OutboxMessage = typeof OutboxMessage.Type;

const isOutboxMessage = Schema.is(OutboxMessage);

export function decodeOutboxMessages(value: unknown): OutboxMessage[] {
  return Array.isArray(value) ? value.filter(isOutboxMessage) : [];
}

export function threadOutboxMessages(
  messages: ReadonlyArray<OutboxMessage>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): OutboxMessage[] {
  return messages
    .filter((message) => message.environmentId === environmentId && message.threadId === threadId)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * The messages to send now: each thread's oldest, so a thread's messages arrive in order. A
 * thread waits while its oldest is sending, was refused, or its environment is not connected.
 */
export function outboxMessagesToSend(
  messages: ReadonlyArray<OutboxMessage>,
  isConnected: (environmentId: EnvironmentId) => boolean,
  sending: ReadonlySet<MessageId>,
): OutboxMessage[] {
  const oldestByThread = new Map<string, OutboxMessage>();
  for (const message of messages) {
    const key = `${message.environmentId}\n${message.threadId}`;
    const oldest = oldestByThread.get(key);
    if (oldest === undefined || message.createdAt.localeCompare(oldest.createdAt) < 0) {
      oldestByThread.set(key, message);
    }
  }
  return [...oldestByThread.values()].filter(
    (message) =>
      message.failure === null &&
      !sending.has(message.messageId) &&
      isConnected(message.environmentId),
  );
}

/** A dropped connection or interrupted send is retried with the same command id; a refusal is not. */
export function outboxFailureAction(input: {
  readonly error: unknown;
  readonly interrupted: boolean;
}): "retry" | "refused" {
  return input.interrupted || shouldRetryThreadOutboxDelivery(input.error) ? "retry" : "refused";
}

/**
 * Whether an environment that is not connected will be again without the user
 * turning it back on: one starting up, reconnecting, offline, or waiting for a
 * fix such as signing in. A switched-off or unsupported one will not.
 */
export function environmentWillConnect(environment: {
  readonly phase: EnvironmentConnectionPhase;
  readonly enabled: boolean;
}): boolean {
  return environment.enabled && environment.phase !== "unsupported";
}

/**
 * Whether a send goes to the outbox. Messages queue while their environment is not connected
 * but will be, including its first connection after the app starts, and keep queueing behind
 * earlier queued ones after it connects so a thread keeps its order. Only plain text queues:
 * attachments upload and context resolves against a live server.
 */
export function outboxSendDecision(input: {
  readonly environmentUnavailable: boolean;
  readonly environmentWillConnect: boolean;
  readonly threadHasOutboxMessages: boolean;
  /** An existing server thread sending one plain-text message to one model. */
  readonly plainTextToServerThread: boolean;
  readonly providerAvailable: boolean;
  /**
   * The environment has not sent its providers since the app started, so a queued message
   * goes to the thread's own model and the server checks it on delivery.
   */
  readonly providerCatalogPending: boolean;
}): "queue" | "reject" | "send" {
  const queueable =
    input.plainTextToServerThread && (input.providerAvailable || input.providerCatalogPending);
  if (!input.environmentUnavailable) {
    return input.threadHasOutboxMessages && queueable ? "queue" : "send";
  }
  return input.environmentWillConnect && queueable ? "queue" : "reject";
}
