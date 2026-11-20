import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  ClaudeOutputFollower,
  claudeOutputCompletesTurn,
  followClaudeDetachedOutput,
} from "./ClaudeDetachedOutput.ts";

const toolUse = {
  type: "assistant",
  uuid: "u-tool",
  parent_tool_use_id: null,
  message: {
    id: "msg_1",
    content: [
      { type: "text", text: "Running it." },
      { type: "tool_use", id: "toolu_done", name: "Read", input: {} },
      { type: "tool_use", id: "toolu_open", name: "Bash", input: { command: "sleep 45" } },
    ],
  },
};
const doneResult = {
  type: "user",
  uuid: "u-done",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_done", content: "x" }] },
};
const progress = { type: "tool_progress", uuid: "u-progress", tool_use_id: "toolu_open" };
const openResult = {
  type: "user",
  uuid: "u-open",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_open", content: "done" }] },
};
const result = { type: "result", subtype: "success", uuid: "u-result", parent_tool_use_id: null };
const lines = (...messages: ReadonlyArray<unknown>) =>
  new TextEncoder().encode(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));

describe("ClaudeOutputFollower", () => {
  it("resumes after the last handled message, first resending tool calls still waiting", () => {
    const follower = new ClaudeOutputFollower("u-progress");
    const replayed = [
      ...follower.pushInitial(
        lines(toolUse, doneResult, progress, { type: "control_request", request_id: "r" }),
      ),
      ...follower.push(lines(openResult, result)),
    ];
    assert.deepEqual(
      replayed.map((message) => message.uuid),
      ["u-tool", "u-open", "u-result"],
    );
    // Only the unanswered call is resent; the text and answered call were shown already.
    assert.deepEqual(
      (replayed[0]!.message as { content: Array<{ id?: string }> }).content.map(
        (block) => block.id,
      ),
      ["toolu_open"],
    );
  });

  it("replays everything when the resume point is not in the file", () => {
    const follower = new ClaudeOutputFollower("u-truncated-away");
    assert.deepEqual(
      follower.pushInitial(lines(openResult, result)).map((message) => message.uuid),
      ["u-open", "u-result"],
    );
  });

  it("drops partial stream events of a message whose start was handled before", () => {
    const follower = new ClaudeOutputFollower("u-tool");
    const delta = (uuid: string, type: string) => ({ type: "stream_event", uuid, event: { type } });
    const text = `${JSON.stringify(toolUse)}\n${JSON.stringify(delta("d1", "content_block_delta"))}\n`;
    const replayed = [
      ...follower.pushInitial(new TextEncoder().encode(text)),
      // A line split across reads is held until it is complete.
      ...follower.push(new TextEncoder().encode(JSON.stringify(delta("d2", "message_stop")))),
      ...follower.push(lines({}).subarray(2)),
      ...follower.push(lines(delta("d3", "message_start"), delta("d4", "content_block_delta"))),
    ];
    assert.deepEqual(
      replayed.map((message) => message.uuid),
      ["u-tool", "d3", "d4"],
    );
  });

  it("knows whether the rest of the file finishes the turn", () => {
    assert.isTrue(claudeOutputCompletesTurn(lines(toolUse, openResult, result), "u-tool"));
    assert.isFalse(claudeOutputCompletesTurn(lines(toolUse, result, openResult), "u-result"));
  });
});

describe("followClaudeDetachedOutput", () => {
  it.effect("reads an exited CLI's file to the end, including a last line without a newline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-detached-" });
        const file = path.join(dir, "stdout.jsonl");
        yield* fileSystem.writeFileString(
          file,
          `${JSON.stringify(toolUse)}\n${JSON.stringify(openResult)}\n${JSON.stringify(result)}`,
        );
        const messages = yield* followClaudeDetachedOutput({
          filePath: file,
          resumeAfterUuid: "u-tool",
          alive: Effect.succeed(false),
        }).pipe(Stream.runCollect);
        assert.deepEqual(
          messages.map((message) => message.uuid),
          ["u-tool", "u-open", "u-result"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
