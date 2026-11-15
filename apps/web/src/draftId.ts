import * as Schema from "effect/Schema";

// Kept out of composerDraftStore so lib/utils can mint ids without importing the store,
// whose toast import would close a cycle back to lib/utils.
export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;
