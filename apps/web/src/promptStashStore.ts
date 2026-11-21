import { ComposerContextRecord, ForwardCompatibleArray } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import {
  PersistedComposerFileAttachment,
  PersistedComposerImageAttachment,
} from "./composerDraftStore";
import { createMemoryStorage, isStorageQuotaError, type StateStorage } from "./lib/storage";

export const PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v2";
const LEGACY_PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v1";
const PROMPT_STASH_STORAGE_VERSION = 2;

const StashEntrySchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  files: Schema.optionalKey(Schema.Array(PersistedComposerFileAttachment)),
  droppedImageNames: Schema.Array(Schema.String),
  unreadableImageNames: Schema.optionalKey(Schema.Array(Schema.String)),
  pendingImageCount: Schema.optionalKey(Schema.Number),
  records: Schema.optionalKey(ForwardCompatibleArray(ComposerContextRecord)),
});
export type PromptStashEntry = typeof StashEntrySchema.Type;

const PersistedPromptStashState = Schema.Struct({
  entries: Schema.Array(StashEntrySchema),
});
type PersistedPromptStashState = typeof PersistedPromptStashState.Type;

const decodePersistedPromptStashState = Schema.decodeUnknownSync(PersistedPromptStashState);

// Encoders cannot survive reload; clear orphaned counts so entries remain restorable.
function clearOrphanedPendingImages(entry: PromptStashEntry): PromptStashEntry {
  if (!entry.pendingImageCount) return entry;
  return {
    ...entry,
    pendingImageCount: 0,
    unreadableImageNames: [
      ...(entry.unreadableImageNames ?? []),
      ...Array.from(
        { length: entry.pendingImageCount },
        (_, index) => `image ${index + 1} (not saved before reload)`,
      ),
    ],
  };
}

/**
 * Write every image when it fits; when storage is full, drop the largest until the
 * write succeeds, and report what was dropped.
 */
export function keepImagesThatFit<
  Result extends { readonly written: boolean; readonly storageFull: boolean },
>(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
  write: (
    kept: ReadonlyArray<PersistedComposerImageAttachment>,
    droppedNames: ReadonlyArray<string>,
  ) => Result,
): {
  kept: ReadonlyArray<PersistedComposerImageAttachment>;
  droppedNames: string[];
  result: Result;
} {
  let kept = [...attachments];
  const droppedNames: string[] = [];
  for (;;) {
    const result = write(kept, droppedNames);
    if (result.written || !result.storageFull || kept.length === 0) {
      return { kept, droppedNames, result };
    }
    const largest = kept.reduce((max, attachment) =>
      attachment.dataUrl.length > max.dataUrl.length ? attachment : max,
    );
    kept = kept.filter((attachment) => attachment !== largest);
    droppedNames.push(largest.name);
  }
}

// Accessing localStorage itself can throw SecurityError before get/set.
function resolveBaseStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {}
  return { storage: createMemoryStorage(), durable: false };
}

const { storage: baseStashStorage, durable: storageIsDurable } = resolveBaseStorage();

/**
 * localStorage holds ~5M characters per origin, shared with drafts. Images stop being
 * stashed past ~60% of that so drafts keep room to save.
 */
export const STASH_IMAGE_STORAGE_BUDGET_CHARS = 3_000_000;

function serializeEntries(entries: ReadonlyArray<PromptStashEntry>): string {
  return JSON.stringify({ version: PROMPT_STASH_STORAGE_VERSION, state: { entries } });
}

interface PersistResult {
  readonly written: boolean;
  readonly durable: boolean;
  /** Only a quota error means storage is full; other failures say nothing about space. */
  readonly storageFull: boolean;
}
const unpersistedFinalizedEntryIds = new Set<string>();

// Clear the composer only after a durable write; debounce cannot confirm durability.
function persistSerialized(serialized: string): PersistResult {
  try {
    baseStashStorage.setItem(PROMPT_STASH_STORAGE_KEY, serialized);
    unpersistedFinalizedEntryIds.clear();
    return { written: true, durable: storageIsDurable, storageFull: false };
  } catch (error) {
    console.error("[PROMPT-STASH] Could not persist stash.", error);
    return { written: false, durable: false, storageFull: isStorageQuotaError(error) };
  }
}

function persistEntries(entries: ReadonlyArray<PromptStashEntry>): PersistResult {
  return persistSerialized(serializeEntries(entries));
}

function readStoredEntries(): ReadonlyArray<PromptStashEntry> | null {
  try {
    const raw = baseStashStorage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    if (!state) return null;
    return decodePersistedPromptStashState(state).entries;
  } catch {
    return null;
  }
}

function readPersistedEntries(): ReadonlyArray<PromptStashEntry> | null {
  return readStoredEntries()?.map(clearOrphanedPendingImages) ?? null;
}

/**
 * Starts each write from storage so other tabs' stashes, takes and finalized images survive.
 * Local encoding and failed finalize writes retain ownership while the stored entry exists.
 */
function latestEntries(memory: ReadonlyArray<PromptStashEntry>): ReadonlyArray<PromptStashEntry> {
  const stored = readStoredEntries();
  if (!stored) return memory;
  const storedIds = new Set(stored.map((entry) => entry.id));
  for (const id of unpersistedFinalizedEntryIds) {
    if (!storedIds.has(id)) unpersistedFinalizedEntryIds.delete(id);
  }
  const memoryById = new Map(memory.map((entry) => [entry.id, entry]));
  return stored.map((entry) => {
    const local = memoryById.get(entry.id);
    if (
      local &&
      (local.pendingImageCount ||
        entry.pendingImageCount ||
        unpersistedFinalizedEntryIds.has(entry.id))
    ) {
      return local;
    }
    return clearOrphanedPendingImages(entry);
  });
}

interface PromptStashStoreState {
  entries: ReadonlyArray<PromptStashEntry>;
  stashEntry: (entry: PromptStashEntry) => {
    /** False when the write failed outright (e.g. quota); nothing was kept. */
    written: boolean;
    storageFull: boolean;
    /** False for failed writes or in-memory fallback; the entry will not survive reload. */
    durable: boolean;
  };
  /** durable=false means removal was not persisted and reload would restore the entry. */
  takeEntry: (entryId: string) => { entry: PromptStashEntry | null; durable: boolean };
  /**
   * attached=false means the entry disappeared while encoding, so images could not be saved.
   * storageDroppedImageNames lists images left out because browser storage was full.
   */
  finalizeEntryImages: (
    entryId: string,
    images: {
      attachments: ReadonlyArray<PersistedComposerImageAttachment>;
      droppedImageNames: ReadonlyArray<string>;
      unreadableImageNames: ReadonlyArray<string>;
    },
  ) => { attached: boolean; durable: boolean; storageDroppedImageNames: ReadonlyArray<string> };
}

export const usePromptStashStore = create<PromptStashStoreState>()((set, get) => ({
  entries: [],
  stashEntry: (entry) => {
    const nextEntries = [entry, ...latestEntries(get().entries)];
    const { written, durable, storageFull } = persistEntries(nextEntries);
    // A failed write keeps the existing stash and the intact composer; nothing is evicted.
    if (!written) {
      return { written: false, durable: false, storageFull };
    }
    set(() => ({ entries: nextEntries }));
    return { written: true, durable, storageFull: false };
  },
  takeEntry: (entryId) => {
    const entries = latestEntries(get().entries);
    const entry = entries.find((candidate) => candidate.id === entryId) ?? null;
    if (!entry) return { entry: null, durable: true };
    const nextEntries = entries.filter((candidate) => candidate.id !== entryId);
    const { durable } = persistEntries(nextEntries);
    unpersistedFinalizedEntryIds.delete(entryId);
    set(() => ({ entries: nextEntries }));
    return { entry, durable };
  },
  finalizeEntryImages: (entryId, images) => {
    const entries = latestEntries(get().entries);
    const index = entries.findIndex((candidate) => candidate.id === entryId);
    const existing = index === -1 ? undefined : entries[index];
    if (!existing) return { attached: false, durable: true, storageDroppedImageNames: [] };
    const withImages = (
      attachments: ReadonlyArray<PersistedComposerImageAttachment>,
      storageDroppedImageNames: ReadonlyArray<string>,
    ) => {
      const nextEntries = [...entries];
      nextEntries[index] = {
        ...existing,
        attachments,
        droppedImageNames: [...images.droppedImageNames, ...storageDroppedImageNames],
        unreadableImageNames: images.unreadableImageNames,
        pendingImageCount: 0,
      };
      return nextEntries;
    };
    const { kept, droppedNames, result } = keepImagesThatFit(
      images.attachments,
      (attachments, dropped) => {
        const serialized = serializeEntries(withImages(attachments, dropped));
        // Over the image budget counts as full, so drafts keep their share of the quota.
        return attachments.length > 0 && serialized.length > STASH_IMAGE_STORAGE_BUDGET_CHARS
          ? { written: false, durable: false, storageFull: true }
          : persistSerialized(serialized);
      },
    );
    if (!result.written) unpersistedFinalizedEntryIds.add(entryId);
    set(() => ({ entries: withImages(kept, droppedNames) }));
    return { attached: true, durable: result.durable, storageDroppedImageNames: droppedNames };
  },
}));

{
  try {
    baseStashStorage.removeItem(LEGACY_PROMPT_STASH_STORAGE_KEY);
  } catch {}
  const persisted = readPersistedEntries();
  if (persisted) {
    usePromptStashStore.setState({ entries: persisted });
  }
}

export function writePromptStashStorageForTest(raw: string): void {
  baseStashStorage.setItem(PROMPT_STASH_STORAGE_KEY, raw);
  usePromptStashStore.setState({ entries: readPersistedEntries() ?? [] });
}

export function promptStashStorageForTest(): StateStorage {
  return baseStashStorage;
}
