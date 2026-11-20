// @effect-diagnostics nodeBuiltinImport:off -- the stand-in CLIs are real processes the registry signals.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { make, type DetachableAgentProcess } from "./detachedAgentTurns.ts";

const makeLinux = make.pipe(Effect.provideService(HostProcess.Platform, "linux"));

/** A process standing in for a CLI, in its own group as the real ones are. */
const spawnStandIn = Effect.acquireRelease(
  Effect.sync(() => {
    const child = NodeChildProcess.spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    return { pid: child.pid!, exited, child };
  }),
  ({ child }) => Effect.sync(() => child.kill("SIGKILL")),
);

const tracked = (input: {
  readonly outputDir: string;
  readonly pid: number;
  readonly runId: string;
  readonly onDetach: () => void;
}): DetachableAgentProcess => ({
  outputDir: input.outputDir,
  threadId: "thread-1",
  nativeThreadId: `native-${input.runId}`,
  pid: input.pid,
  unit: undefined,
  activeRunId: () => input.runId,
  resumeAfterUuid: () => "u-handled",
  detach: input.onDetach,
});

const writeRecord = (dir: string, fields: { readonly pid: number; readonly runId: string }) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "record.json"),
    JSON.stringify({
      version: 1,
      driver: "claude",
      threadId: "thread-1",
      runId: fields.runId,
      nativeThreadId: `native-${fields.runId}`,
      pid: fields.pid,
      startTime: "0",
      resumeAfterUuid: "u-handled",
      detachedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
};

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-detached-turns-" }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

describe("DetachedAgentTurns", () => {
  it.effect("leaves running only CLIs on a continued run, for the next server to adopt", () =>
    Effect.gen(function* () {
      const first = yield* makeLinux;
      const continued = yield* spawnStandIn;
      const other = yield* spawnStandIn;
      const detached: Array<string> = [];
      const continuedDir = (yield* first.allocate)!;
      const otherDir = (yield* first.allocate)!;
      yield* first.track(
        tracked({
          outputDir: continuedDir,
          pid: continued.pid,
          runId: "run-1",
          onDetach: () => detached.push("run-1"),
        }),
      );
      yield* first.track(
        tracked({
          outputDir: otherDir,
          pid: other.pid,
          runId: "run-2",
          onDetach: () => detached.push("run-2"),
        }),
      );
      assert.equal(yield* first.detach(new Set(["run-1"])), 1);
      assert.deepEqual(detached, ["run-1"]);
      assert.isFalse(NodeFS.existsSync(NodePath.join(otherDir, "record.json")));

      // The next server finds only the detached turn; the other CLI's output is left over.
      const next = yield* makeLinux;
      assert.isFalse(NodeFS.existsSync(otherDir));
      assert.isTrue(yield* next.adoptable("run-1"));
      const turn = yield* next.claim({ nativeThreadId: "native-run-1", runId: "run-1" });
      assert.equal(turn?.pid, continued.pid);
      assert.equal(turn?.resumeAfterUuid, "u-handled");
      assert.isFalse(NodeFS.existsSync(NodePath.join(continuedDir, "record.json")));
      assert.isUndefined(yield* next.claim({ nativeThreadId: "native-run-1", runId: "run-1" }));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stops a detached CLI when another turn of its session starts first", () =>
    Effect.gen(function* () {
      const first = yield* makeLinux;
      const cli = yield* spawnStandIn;
      const outputDir = (yield* first.allocate)!;
      yield* first.track(tracked({ outputDir, pid: cli.pid, runId: "run-1", onDetach: () => {} }));
      yield* first.detach(new Set(["run-1"]));

      const next = yield* makeLinux;
      assert.isUndefined(yield* next.claim({ nativeThreadId: "native-run-1", runId: undefined }));
      yield* Effect.promise(() => cli.exited);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("adopts a turn that ended while no server ran only if its output finishes it", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const root = NodePath.join(stateDir, "agent-turns");
      const finished = NodePath.join(root, "finished");
      const cut = NodePath.join(root, "cut");
      // A dead PID: this test's own stand-in, already reaped.
      const gone = yield* Effect.scoped(
        Effect.gen(function* () {
          const standIn = yield* spawnStandIn;
          return standIn;
        }),
      );
      yield* Effect.promise(() => gone.exited);
      writeRecord(finished, { pid: gone.pid, runId: "run-finished" });
      NodeFS.writeFileSync(
        NodePath.join(finished, "stdout.jsonl"),
        `${JSON.stringify({ type: "assistant", uuid: "u-handled", message: { content: [] } })}\n` +
          `${JSON.stringify({ type: "result", subtype: "success", uuid: "u-result" })}\n`,
      );
      writeRecord(cut, { pid: gone.pid, runId: "run-cut" });
      NodeFS.writeFileSync(NodePath.join(cut, "stdout.jsonl"), "");

      const registry = yield* makeLinux;
      assert.isTrue(yield* registry.adoptable("run-finished"));
      assert.isFalse(yield* registry.adoptable("run-cut"));
      assert.isFalse(NodeFS.existsSync(cut));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
