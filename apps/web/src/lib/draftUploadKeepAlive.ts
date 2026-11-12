import type { EnvironmentId } from "@t3tools/contracts";

import { useComposerDraftStore, type ComposerThreadDraftState } from "../composerDraftStore";
import { usePromptStashStore, type PromptStashEntry } from "../promptStashStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { verifyStashedAttachmentUpload } from "./attachmentUploadQueue";

// The server deletes uploads no client has asked about for 30 days; a daily refresh keeps
// every draft and stash upload alive while the app is in use, even unopened ones.
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Uploaded attachment ids that saved drafts and stash entries still reference, by environment. */
export function referencedDraftUploads(input: {
  readonly drafts: Iterable<Pick<ComposerThreadDraftState, "files">>;
  readonly stashEntries: ReadonlyArray<Pick<PromptStashEntry, "files">>;
}): ReadonlyMap<EnvironmentId, ReadonlySet<string>> {
  const byEnvironment = new Map<EnvironmentId, Set<string>>();
  const add = (environmentId: EnvironmentId, attachmentId: string) => {
    const ids = byEnvironment.get(environmentId) ?? new Set<string>();
    ids.add(attachmentId);
    byEnvironment.set(environmentId, ids);
  };
  for (const draft of input.drafts) {
    for (const file of draft.files) {
      if (file.uploadedAttachmentId && file.uploadEnvironmentId) {
        add(file.uploadEnvironmentId, file.uploadedAttachmentId);
      }
    }
  }
  for (const entry of input.stashEntries) {
    for (const file of entry.files ?? []) add(file.environmentId, file.attachmentId);
  }
  return byEnvironment;
}

/** Asks each connected environment about its draft uploads on load, then daily. */
export function startDraftUploadKeepAlive(): void {
  const refreshedAt = new Map<EnvironmentId, number>();
  const refresh = () => {
    const now = Date.now();
    const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
    const referenced = referencedDraftUploads({
      drafts: Object.values(useComposerDraftStore.getState().draftsByThreadKey),
      stashEntries: usePromptStashStore.getState().entries,
    });
    for (const [environmentId, attachmentIds] of referenced) {
      if (presentations.get(environmentId)?.connection.phase !== "connected") continue;
      const last = refreshedAt.get(environmentId);
      if (last !== undefined && now - last < REFRESH_INTERVAL_MS) continue;
      refreshedAt.set(environmentId, now);
      void (async () => {
        // One at a time keeps the request burst small; failures wait for the next refresh.
        for (const attachmentId of attachmentIds) {
          await verifyStashedAttachmentUpload({ environmentId, attachmentId }).catch(() => {});
        }
      })();
    }
  };
  appAtomRegistry.subscribe(environmentPresentations.presentationsAtom, refresh);
  window.setInterval(refresh, REFRESH_INTERVAL_MS);
  refresh();
}
