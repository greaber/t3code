# Context in portable handoffs

T3 Code transfers conversation context when you switch providers, continue through a portable
restart, or use a fork that the provider cannot resume itself.

When the conversation fits, T3 transfers all eligible items. For longer conversations, it favors your
original request, later instructions and corrections, then replies and plans, while keeping space
for recent evidence such as command outcomes. Selected messages keep their full text, order, and
user or assistant role, including partial work from failed or interrupted turns. Your new request stays separate and is never shortened to make history fit.

Codex receives historical messages directly when its installed version supports that operation.
Other providers receive the same selection as attributed conversation context. A handoff does not
copy the outgoing provider's reasoning, tool-call state, or attachments.

On desktop and web, when you select a different provider in an existing conversation, the pending
handoff offers **Ask outgoing model for a brief** if the previous model is available. This requests
one extra reply from that model about your goal, decisions, verified work, and next steps. It leaves
your draft and destination model selected. Send your message while the brief is being written to
queue it for the new provider. To switch immediately, just send without requesting a brief; this
also works when the old provider is rate-limited.

If T3 leaves items out of the handoff, they remain in the thread. The notice refers to T3's handoff
allowance, not a rejection by the model. The new agent can use the thread-reading tool to retrieve
specific older messages and activity. A brief supplements the selected history; it does not replace it.

## Context limits

A handoff must leave room for existing provider context, your request and attachments, instructions,
tools, and subsequent work. If the target conversation has no room for the handoff, T3 Code starts
a fresh provider conversation with a bounded selection of saved history and sends your request
automatically. You do not need to compact manually. If the request and attachments leave too little
room even in a fresh conversation, shorten the request or select a larger-context model. T3 Code
never shortens your request to make it fit.

Recovery leaves running background work intact. Let it finish or stop it before retrying the handoff.

By default, history may use up to half of the target model's context window, or 200,000 tokens
when the window is unknown. Switching a long thread to a large-window model can therefore send a
lot of history on the first turn, which costs tokens with providers that bill by usage; start a
new thread instead when you do not need the earlier conversation. Server operators can set `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` to use a
fixed allowance instead (clamped to 1,024–1,000,000). Either way it is an upper bound, not a
provider context-window guarantee. Text accounting conservatively charges one token per UTF-8 byte,
including attribution and JSON escaping. Your current input and attachments do not count against
the allowance.

T3 Code uses available capacity information for your selected model and options, together with
provider context telemetry. For native Antigravity's Gemini 4 Neon, T3 can use the published
one-million-token window on the first handoff; a window reported for that model by the agent takes
precedence. Starting a fresh provider conversation clears prior usage, while keeping known model
capacity. Changing models or context-window options discards stale usage and compaction thresholds.

When no capacity information is available, T3 Code assumes a 128,000-token window. It reserves at
least 16,000 tokens, or a quarter of the window when larger, for instructions, tools, and subsequent
work. Images reserve an estimated 8,192 tokens each, independent of their file size; other
attachments reserve 4,096 each for their references. Existing context is estimated from saved
activity when usage telemetry is unavailable. Known smaller windows still constrain the handoff.
These are fallback estimates, not exact token counts. Image resolution, custom models, and hidden
native context can differ, so the provider may still reject an input.
