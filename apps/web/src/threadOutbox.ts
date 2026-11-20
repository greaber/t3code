import type { EnvironmentId, MessageId } from "@t3tools/contracts";
import { createStore, type StoreApi } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import {
  decodeOutboxMessages,
  outboxFailureAction,
  outboxMessagesToSend,
  type OutboxMessage,
} from "./threadOutbox.logic";

export interface ThreadOutboxState {
  readonly messages: ReadonlyArray<OutboxMessage>;
  /** Messages sending or waiting to retry; the user cannot change them meanwhile. */
  readonly busy: ReadonlyArray<MessageId>;
  readonly enqueue: (message: OutboxMessage) => void;
  readonly remove: (messageId: MessageId) => void;
  readonly refuse: (messageId: MessageId, reason: string) => void;
  readonly retry: (messageId: MessageId) => void;
  readonly setBusy: (messageId: MessageId, busy: boolean) => void;
}

export function createThreadOutboxStore(storage: StateStorage): StoreApi<ThreadOutboxState> {
  return createStore<ThreadOutboxState>()(
    persist(
      (set) => ({
        messages: [],
        busy: [],
        enqueue: (message) =>
          set((state) => ({
            messages: [
              ...state.messages.filter((entry) => entry.messageId !== message.messageId),
              message,
            ],
          })),
        remove: (messageId) =>
          set((state) => ({
            messages: state.messages.filter((entry) => entry.messageId !== messageId),
          })),
        refuse: (messageId, reason) =>
          set((state) => ({
            messages: state.messages.map((entry) =>
              entry.messageId === messageId ? { ...entry, failure: reason } : entry,
            ),
          })),
        retry: (messageId) =>
          set((state) => ({
            messages: state.messages.map((entry) =>
              entry.messageId === messageId ? { ...entry, failure: null } : entry,
            ),
          })),
        setBusy: (messageId, busy) =>
          set((state) => ({
            busy: busy
              ? [...state.busy.filter((id) => id !== messageId), messageId]
              : state.busy.filter((id) => id !== messageId),
          })),
      }),
      {
        name: "t3code:thread-outbox:v1",
        version: 1,
        storage: createJSONStorage(() => storage),
        partialize: ({ messages }) => ({ messages }),
        merge: (persisted, current) => ({
          ...current,
          messages: decodeOutboxMessages((persisted as { messages?: unknown } | null)?.messages),
        }),
      },
    ),
  );
}

export type OutboxSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown; readonly interrupted: boolean };

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

/**
 * Sends each thread's queued messages in order once its environment connects. A send that
 * fails without an answer retries with the same command id, which the server accepts at most
 * once; a refused message stays queued, marked, until the user retries, edits, or removes it.
 */
export function startThreadOutboxDelivery(input: {
  readonly store: StoreApi<ThreadOutboxState>;
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  readonly subscribeConnection: (environmentId: EnvironmentId, onChange: () => void) => () => void;
  readonly send: (message: OutboxMessage) => Promise<OutboxSendResult>;
  readonly describeError: (error: unknown) => string;
}): () => void {
  const { store } = input;
  const connections = new Map<EnvironmentId, () => void>();
  const retryAttempts = new Map<MessageId, number>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  const deliver = async (message: OutboxMessage) => {
    const state = store.getState();
    state.setBusy(message.messageId, true);
    let result: OutboxSendResult;
    try {
      result = await input.send(message);
    } catch (error) {
      result = { ok: false, error, interrupted: false };
    }
    const current = store.getState();
    if (result.ok) {
      retryAttempts.delete(message.messageId);
      current.remove(message.messageId);
      current.setBusy(message.messageId, false);
      return;
    }
    if (outboxFailureAction(result) === "refused") {
      retryAttempts.delete(message.messageId);
      current.refuse(message.messageId, input.describeError(result.error));
      current.setBusy(message.messageId, false);
      return;
    }
    // A dropped connection resumes on reconnect; a live one backs off before retrying.
    const attempt = (retryAttempts.get(message.messageId) ?? 0) + 1;
    retryAttempts.set(message.messageId, attempt);
    const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      store.getState().setBusy(message.messageId, false);
    }, delayMs);
    retryTimers.add(timer);
  };

  let pumping = false;
  let pumpAgain = false;
  const pump = () => {
    if (stopped) return;
    // Starting a send updates the store, which calls back in here before the loop finishes.
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        pumpOnce();
      } while (pumpAgain && !stopped);
    } finally {
      pumping = false;
    }
  };

  const pumpOnce = () => {
    const { messages, busy } = store.getState();
    const environmentIds = new Set(messages.map((message) => message.environmentId));
    for (const [environmentId, unsubscribe] of connections) {
      if (!environmentIds.has(environmentId)) {
        unsubscribe();
        connections.delete(environmentId);
      }
    }
    for (const environmentId of environmentIds) {
      if (!connections.has(environmentId)) {
        connections.set(environmentId, input.subscribeConnection(environmentId, pump));
      }
    }
    for (const message of outboxMessagesToSend(messages, input.isConnected, new Set(busy))) {
      void deliver(message);
    }
  };

  const unsubscribeStore = store.subscribe(pump);
  pump();
  return () => {
    stopped = true;
    unsubscribeStore();
    for (const unsubscribe of connections.values()) unsubscribe();
    connections.clear();
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
  };
}
