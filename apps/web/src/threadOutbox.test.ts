import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createMemoryStorage } from "./lib/storage";
import {
  createThreadOutboxStore,
  startThreadOutboxDelivery,
  type OutboxSendResult,
} from "./threadOutbox";
import { outboxSendDecision, type OutboxMessage } from "./threadOutbox.logic";

const devbox = EnvironmentId.make("environment:devbox");
const laptop = EnvironmentId.make("environment:laptop");

function outboxMessage(id: string, overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    environmentId: devbox,
    threadId: ThreadId.make("thread:a"),
    messageId: MessageId.make(`message:${id}`),
    commandId: CommandId.make(`command:${id}`),
    text: id,
    draftText: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: `2026-11-20T09:00:0${id.length}.000Z`,
    failure: null,
    ...overrides,
  };
}

function setup() {
  const storage = createMemoryStorage();
  const store = createThreadOutboxStore(storage);
  const connected = new Set<EnvironmentId>();
  const listeners = new Map<EnvironmentId, () => void>();
  const sends: Array<{ message: OutboxMessage; finish: (result: OutboxSendResult) => void }> = [];
  const stop = startThreadOutboxDelivery({
    store,
    isConnected: (environmentId) => connected.has(environmentId),
    subscribeConnection: (environmentId, onChange) => {
      listeners.set(environmentId, onChange);
      return () => listeners.delete(environmentId);
    },
    send: (message) =>
      new Promise((resolve) => {
        sends.push({ message, finish: resolve });
      }),
    describeError: (error) => (error instanceof Error ? error.message : "refused"),
  });
  const connect = (environmentId: EnvironmentId, isConnected: boolean) => {
    if (isConnected) connected.add(environmentId);
    else connected.delete(environmentId);
    listeners.get(environmentId)?.();
  };
  const settle = async (
    index: number,
    result: OutboxSendResult,
    settled = () => expect(store.getState().busy).not.toContain(sends[index]!.message.messageId),
  ) => {
    sends[index]!.finish(result);
    await vi.waitFor(settled);
  };
  return { storage, store, sends, connect, settle, stop };
}

describe("thread outbox delivery", () => {
  it("sends each thread's messages in order once its environment connects", async () => {
    const { store, sends, connect, settle, stop } = setup();
    const first = outboxMessage("a");
    const second = outboxMessage("bb");
    const otherThread = outboxMessage("c", { threadId: ThreadId.make("thread:b") });
    const otherEnvironment = outboxMessage("d", { environmentId: laptop });
    store.getState().enqueue(second);
    store.getState().enqueue(first);
    store.getState().enqueue(otherThread);
    store.getState().enqueue(otherEnvironment);
    expect(sends).toHaveLength(0);

    connect(devbox, true);
    expect(sends.map(({ message }) => message.messageId)).toEqual([
      first.messageId,
      otherThread.messageId,
    ]);

    await settle(0, { ok: true });
    expect(sends.map(({ message }) => message.messageId)).toEqual([
      first.messageId,
      otherThread.messageId,
      second.messageId,
    ]);
    expect(store.getState().messages.map((message) => message.messageId)).not.toContain(
      first.messageId,
    );
    expect(store.getState().messages.map((message) => message.messageId)).toContain(
      otherEnvironment.messageId,
    );
    stop();
  });

  it("retries an unanswered send with the same command id and holds a refused one", async () => {
    vi.useFakeTimers();
    try {
      const { store, sends, connect, settle, stop } = setup();
      const first = outboxMessage("a");
      const second = outboxMessage("bb");
      store.getState().enqueue(first);
      store.getState().enqueue(second);
      connect(devbox, true);

      // The socket dropped mid-send: the server may or may not have the message.
      await settle(
        0,
        { ok: false, error: new Error("Socket is not connected"), interrupted: false },
        () => expect(vi.getTimerCount()).toBe(1),
      );
      expect(sends).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sends).toHaveLength(2);
      expect(sends[1]!.message.commandId).toBe(first.commandId);
      expect(sends[1]!.message.messageId).toBe(first.messageId);

      await settle(1, {
        ok: false,
        error: { _tag: "OrchestrationDispatchCommandError", message: "Thread was deleted." },
        interrupted: false,
      });
      expect(store.getState().messages.find((m) => m.messageId === first.messageId)?.failure).toBe(
        "refused",
      );
      // A refused message keeps the ones behind it waiting, so they never overtake it.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sends).toHaveLength(2);

      store.getState().remove(first.messageId);
      expect(sends.at(-1)?.message.messageId).toBe(second.messageId);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps queued messages across a restart", async () => {
    const { storage, store, stop } = setup();
    const message = outboxMessage("a");
    store.getState().enqueue(message);
    stop();

    const reopened = createThreadOutboxStore(storage);
    await vi.waitFor(() => expect(reopened.getState().messages).toEqual([message]));
  });
});

describe("outboxSendDecision", () => {
  it.each([
    ["queues plain text while reconnecting", true, true, false, true, "queue"],
    ["rejects attachments while reconnecting", true, true, false, false, "reject"],
    ["rejects while switched off or refused", true, false, false, true, "reject"],
    ["queues behind waiting messages once connected", false, false, true, true, "queue"],
    ["sends attachments directly once connected", false, false, true, false, "send"],
    ["sends directly with nothing waiting", false, false, false, true, "send"],
  ] as const)(
    "%s",
    (
      _name,
      environmentUnavailable,
      environmentReconnecting,
      threadHasOutboxMessages,
      plainTextToServerThread,
      expected,
    ) => {
      expect(
        outboxSendDecision({
          environmentUnavailable,
          environmentReconnecting,
          threadHasOutboxMessages,
          plainTextToServerThread,
        }),
      ).toBe(expected);
    },
  );
});
