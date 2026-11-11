import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";

import {
  PROMPT_STASH_STORAGE_KEY,
  keepImagesThatFit,
  usePromptStashStore,
  writePromptStashStorageForTest,
  type PromptStashEntry,
} from "./promptStashStore";

function makeEntry(input: {
  id: string;
  prompt?: string;
  attachmentChars?: number;
}): PromptStashEntry {
  return {
    id: input.id,
    createdAt: "2026-07-24T12:00:00.000Z",
    prompt: input.prompt ?? `prompt ${input.id}`,
    attachments:
      input.attachmentChars !== undefined
        ? [
            {
              id: `${input.id}-img`,
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: input.attachmentChars,
              dataUrl: "x".repeat(input.attachmentChars),
            },
          ]
        : [],
    droppedImageNames: [],
  };
}

function resetPromptStashStore() {
  usePromptStashStore.setState({ entries: [] });
  writePromptStashStorageForTest("");
  removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
}

describe("keepImagesThatFit", () => {
  const image = (id: string, chars: number) => ({
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: chars,
    dataUrl: "x".repeat(chars),
  });

  it("keeps every image that storage accepts, dropping the largest first when it is full", () => {
    const images = [image("small", 10), image("huge", 1_000), image("medium", 100)];
    const writes: Array<ReadonlyArray<string>> = [];
    const fits = keepImagesThatFit(images, (kept) => {
      writes.push(kept.map((attachment) => attachment.id));
      return { written: true };
    });
    expect(fits.kept).toEqual(images);
    expect(fits.droppedNames).toEqual([]);

    writes.length = 0;
    const full = keepImagesThatFit(images, (kept, dropped) => {
      writes.push([...kept.map((attachment) => attachment.id), ...dropped]);
      return { written: kept.reduce((sum, attachment) => sum + attachment.dataUrl.length, 0) < 50 };
    });
    expect(full.kept.map((attachment) => attachment.id)).toEqual(["small"]);
    expect(full.droppedNames).toEqual(["huge.png", "medium.png"]);
    expect(writes).toEqual([
      ["small", "huge", "medium"],
      ["small", "medium", "huge.png"],
      ["small", "huge.png", "medium.png"],
    ]);

    const nothingFits = keepImagesThatFit(images, () => ({ written: false }));
    expect(nothingFits.kept).toEqual([]);
    expect(nothingFits.result.written).toBe(false);
  });
});

describe("promptStashStore", () => {
  beforeEach(() => {
    resetPromptStashStore();
  });

  afterEach(() => {
    resetPromptStashStore();
  });

  it("restores citations and bound comments from a persisted stash", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("remote-source"),
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: "A quote to revisit later.",
      comment: "Revisit this tomorrow.\nCheck whether the example still applies.",
      start: 0,
      end: 24,
      prefix: "",
      suffix: " Next.",
    };
    const prompt = `Revisit ${serializeAssistantCitation(citation)}`;
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [makeEntry({ id: "citation-stash", prompt })] },
      }),
    );
    const restored = usePromptStashStore.getState().takeEntry("citation-stash").entry;
    expect(restored?.prompt).toBe(prompt);
    expect(
      collectAssistantCitations(restored?.prompt ?? "").map((entry) => entry.citation),
    ).toEqual([citation]);
    expect(usePromptStashStore.getState().takeEntry("citation-stash").entry).toBeNull();
  });

  it("keeps every stashed entry, newest first", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < 50; index += 1) {
      expect(store.stashEntry(makeEntry({ id: `entry-${index}` })).written).toBe(true);
    }
    const entries = usePromptStashStore.getState().entries;
    expect(entries).toHaveLength(50);
    expect(entries[0]?.id).toBe("entry-49");
    expect(entries.at(-1)?.id).toBe("entry-0");
  });

  // regression: #4787 stashed prompts were lost when switching providers
  it("distinguishes a memory-only write (written, not durable) from a failed one", () => {
    const store = usePromptStashStore.getState();
    const result = store.stashEntry(makeEntry({ id: "memory-only" }));
    expect(result.written).toBe(true);
    expect(result.durable).toBe(false);
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "memory-only",
    ]);
  });

  it("takeEntry returns images and drop metadata finalized after a menu snapshot", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry({ ...makeEntry({ id: "pending-restore" }), pendingImageCount: 1 });
    const menuSnapshot = usePromptStashStore.getState().entries[0];
    expect(menuSnapshot?.attachments).toEqual([]);

    store.finalizeEntryImages("pending-restore", {
      attachments: [
        {
          id: "img-finalized",
          name: "finalized.webp",
          mimeType: "image/webp",
          sizeBytes: 12,
          dataUrl: "data:image/webp;base64,BBBB",
        },
      ],
      droppedImageNames: ["too-large.png"],
      unreadableImageNames: ["unreadable.png"],
    });

    const { entry: taken } = store.takeEntry("pending-restore");
    expect(taken).not.toBe(menuSnapshot);
    expect(taken).toMatchObject({
      attachments: [
        {
          id: "img-finalized",
          name: "finalized.webp",
        },
      ],
      droppedImageNames: ["too-large.png"],
      unreadableImageNames: ["unreadable.png"],
      pendingImageCount: 0,
    });
  });

  it("preserves uploaded file references without storing file contents", () => {
    const store = usePromptStashStore.getState();
    const file = {
      id: "file-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      attachmentId: "pending-report-pdf",
      environmentId: EnvironmentId.make("environment-1"),
    };

    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [{ ...makeEntry({ id: "with-file" }), files: [file] }] },
      }),
    );
    store.finalizeEntryImages("with-file", {
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
    });

    expect(usePromptStashStore.getState().entries[0]?.files).toEqual([file]);
  });

  it("finalizeEntryImages reports false when the entry was already taken", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry({ ...makeEntry({ id: "racing" }), pendingImageCount: 1 });
    store.takeEntry("racing");

    const { attached } = store.finalizeEntryImages("racing", {
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
    });

    expect(attached).toBe(false);
  });

  it("settles a pending count left behind by a crashed or closed session", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: {
          entries: [{ ...makeEntry({ id: "orphan" }), pendingImageCount: 2 }],
        },
      }),
    );

    const entry = usePromptStashStore.getState().entries[0];
    expect(entry?.pendingImageCount).toBe(0);
    expect(entry?.unreadableImageNames).toHaveLength(2);
  });

  it("ignores an unreadable v1 payload seeded under the current key", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 1,
        state: { queuesByScopeKey: { "provider:claudeAgent": [] } },
      }),
    );
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });
});

describe("prompt stash context records", () => {
  it("restores the records behind a persisted prompt's chips", () => {
    const records = [
      {
        version: 1 as const,
        contextId: "ctx-1" as never,
        kind: "terminal" as const,
        label: "Terminal 1 line 4",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "boom",
      },
    ];
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: {
          entries: [
            {
              id: "entry-records",
              createdAt: "2026-01-01T00:00:00.000Z",
              prompt: "see [Terminal 1 line 4](t3-context://v1/terminal/ctx-1)",
              attachments: [],
              droppedImageNames: [],
              records,
            },
          ],
        },
      }),
    );
    const taken = usePromptStashStore.getState().takeEntry("entry-records");
    expect(taken.entry?.records).toEqual(records);
  });
});
