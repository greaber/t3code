import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useStore } from "zustand";

import { resolveStorage } from "./lib/storage";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentPresentations } from "./state/presentation";
import { threadEnvironment } from "./state/threads";
import {
  createThreadOutboxStore,
  startThreadOutboxDelivery,
  type ThreadOutboxState,
} from "./threadOutbox";

export const threadOutboxStore = createThreadOutboxStore(
  resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
);

export function useThreadOutbox<T>(selector: (state: ThreadOutboxState) => T): T {
  return useStore(threadOutboxStore, selector);
}

const isConnected = (
  environmentId: Parameters<typeof environmentPresentations.presentationAtom>[0],
) =>
  appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
    .phase === "connected";

export function startAppThreadOutboxDelivery(): void {
  startThreadOutboxDelivery({
    store: threadOutboxStore,
    isConnected,
    subscribeConnection: (environmentId, onChange) =>
      appAtomRegistry.subscribe(environmentPresentations.presentationAtom(environmentId), onChange),
    send: async (message) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.startTurn,
        {
          environmentId: message.environmentId,
          input: {
            threadId: message.threadId,
            commandId: message.commandId,
            message: {
              messageId: message.messageId,
              role: "user",
              text: message.text,
              attachments: [],
            },
            modelSelection: message.modelSelection,
            runtimeMode: message.runtimeMode,
            interactionMode: message.interactionMode,
            // Written without seeing the thread's current turn, so it never steers into one.
            dispatchMode: "queue",
            createdAt: message.createdAt,
          },
        },
        { reportFailure: false },
      );
      return result._tag === "Success"
        ? { ok: true }
        : {
            ok: false,
            error: squashAtomCommandFailure(result),
            interrupted: isAtomCommandInterrupted(result),
          };
    },
    describeError: (error) => (error instanceof Error ? error.message : "The server refused it."),
  });
}
