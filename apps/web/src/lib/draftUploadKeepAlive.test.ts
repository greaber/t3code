import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { referencedDraftUploads } from "./draftUploadKeepAlive";

describe("referencedDraftUploads", () => {
  it("collects uploads from saved drafts and stash entries by environment", () => {
    const local = EnvironmentId.make("environment-local");
    const remote = EnvironmentId.make("environment-remote");
    const file = { id: "file", name: "notes.pdf", mimeType: "application/pdf", sizeBytes: 1 };
    const referenced = referencedDraftUploads({
      drafts: [
        {
          files: [
            {
              ...file,
              type: "file",
              file: null,
              uploadedAttachmentId: "a",
              uploadEnvironmentId: local,
            },
            // Not uploaded yet, so the server holds nothing for it.
            { ...file, type: "file", file: null },
          ],
        },
        {
          files: [
            {
              ...file,
              type: "file",
              file: null,
              uploadedAttachmentId: "a",
              uploadEnvironmentId: local,
            },
          ],
        },
      ],
      stashEntries: [{ files: [{ ...file, attachmentId: "b", environmentId: remote }] }, {}],
    });
    expect(Object.fromEntries([...referenced].map(([id, ids]) => [id, [...ids]]))).toEqual({
      [local]: ["a"],
      [remote]: ["b"],
    });
  });
});
