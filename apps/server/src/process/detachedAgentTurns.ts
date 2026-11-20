import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { claudeOutputCompletesTurn } from "../orchestration-v2/Adapters/ClaudeDetachedOutput.ts";

/**
 * Agent CLIs that were mid-turn when the server shut down keep running, write
 * their output to a file, and are adopted by the next server. See
 * `spawnClaudeProcessGroup` for the process side.
 */

const OUTPUT_ROOT = "agent-turns";
const RECORD_FILE = "record.json";
export const DETACHED_STDOUT_FILE = "stdout.jsonl";
// Restart continuations wait for activation; a turn nobody adopts by then is stopped.
const UNCLAIMED_DEADLINE = "10 minutes";
const KILL_GRACE = "5 seconds";

const DetachedAgentTurnRecord = Schema.Struct({
  version: Schema.Literal(1),
  driver: Schema.Literal("claude"),
  threadId: Schema.String,
  runId: Schema.String,
  nativeThreadId: Schema.String,
  pid: Schema.Number,
  startTime: Schema.String,
  unit: Schema.optional(Schema.String),
  resumeAfterUuid: Schema.optional(Schema.String),
  detachedAt: Schema.String,
});
type DetachedAgentTurnRecord = typeof DetachedAgentTurnRecord.Type;
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(DetachedAgentTurnRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(DetachedAgentTurnRecord));

export interface DetachedAgentTurn extends DetachedAgentTurnRecord {
  readonly outputDir: string;
  readonly stdoutPath: string;
}

/** A CLI this server started, registered so shutdown can leave it running. */
export interface DetachableAgentProcess {
  readonly outputDir: string;
  readonly threadId: string;
  readonly nativeThreadId: string;
  readonly pid: number;
  readonly unit: string | undefined;
  readonly activeRunId: () => string | null;
  readonly resumeAfterUuid: () => string | undefined;
  /** Tells the process guard not to stop the CLI when this server goes away. */
  readonly detach: () => void;
}

export interface DetachedAgentTurnsShape {
  /** A fresh output directory for one CLI, or undefined where turns cannot survive restarts. */
  readonly allocate: Effect.Effect<string | undefined>;
  readonly track: (process: DetachableAgentProcess) => Effect.Effect<void>;
  /** Forgets a CLI that exited while this server still owned it, and deletes its output. */
  readonly release: (outputDir: string) => Effect.Effect<void>;
  /** Leaves running the CLIs whose active run is in `runIds`. Returns how many. */
  readonly detach: (runIds: ReadonlySet<string>) => Effect.Effect<number>;
  readonly adoptable: (runId: string) => Effect.Effect<boolean>;
  /**
   * Takes the detached turn of a native session. A turn for another run, or
   * one with nothing left to show, is stopped instead and yields undefined.
   */
  readonly claim: (input: {
    readonly nativeThreadId: string;
    readonly runId: string | undefined;
  }) => Effect.Effect<DetachedAgentTurn | undefined>;
  readonly alive: (turn: DetachedAgentTurn) => Effect.Effect<boolean>;
  /** Stops an adopted CLI, its scope, and deletes its output. */
  readonly kill: (turn: DetachedAgentTurn) => Effect.Effect<void>;
  /** Reaps what an adopted CLI left after it exited, and deletes its output. */
  readonly finish: (turn: DetachedAgentTurn) => Effect.Effect<void>;
}

export const DetachedAgentTurns = Context.Reference<DetachedAgentTurnsShape>(
  "t3/process/DetachedAgentTurns",
  {
    defaultValue: () => ({
      allocate: Effect.undefined,
      track: () => Effect.void,
      release: () => Effect.void,
      detach: () => Effect.succeed(0),
      adoptable: () => Effect.succeed(false),
      claim: () => Effect.undefined,
      alive: () => Effect.succeed(false),
      kill: () => Effect.void,
      finish: () => Effect.void,
    }),
  },
);

/** Field 22 of /proc/<pid>/stat: start time in clock ticks since boot, which tells a reused PID apart. */
function procStartTime(stat: string): string | undefined {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19];
}

/** Scopes of detached turns that the startup sweep of leftover agents must keep. */
export const readDetachedAgentUnits = Effect.fn("DetachedAgentTurns.readUnits")(function* (
  stateDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(stateDir, OUTPUT_ROOT);
  const units = new Set<string>();
  for (const entry of yield* fileSystem.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    const record = yield* fileSystem
      .readFileString(path.join(root, entry, RECORD_FILE))
      .pipe(Effect.flatMap(decodeRecord), Effect.option);
    if (record._tag === "Some" && record.value.unit !== undefined) units.add(record.value.unit);
  }
  return units;
});

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  // Liveness checks read /proc; other platforms keep stopping agents on shutdown.
  if (platform !== "linux") return DetachedAgentTurns.defaultValue();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const agentScope = yield* AgentScope;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const layerScope = yield* Effect.scope;
  const root = path.join(stateDir, OUTPUT_ROOT);

  const tracked = new Map<string, DetachableAgentProcess>();
  const pending = new Map<string, DetachedAgentTurn>();

  const removeDir = (dir: string) =>
    fileSystem.remove(dir, { recursive: true }).pipe(Effect.ignore);

  const startTimeOf = (pid: number) =>
    fileSystem.readFileString(`/proc/${pid}/stat`).pipe(
      Effect.map(procStartTime),
      Effect.orElseSucceed(() => undefined),
    );

  const alive = (turn: DetachedAgentTurn) =>
    startTimeOf(turn.pid).pipe(Effect.map((startTime) => startTime === turn.startTime));

  const completesTurn = (turn: DetachedAgentTurn) =>
    fileSystem.readFile(turn.stdoutPath).pipe(
      Effect.map((bytes) => claudeOutputCompletesTurn(bytes, turn.resumeAfterUuid)),
      Effect.orElseSucceed(() => false),
    );

  const isAdoptable = (turn: DetachedAgentTurn) =>
    alive(turn).pipe(Effect.flatMap((live) => (live ? Effect.succeed(true) : completesTurn(turn))));

  const signal = (turn: DetachedAgentTurn, name: NodeJS.Signals) =>
    Effect.sync(() => {
      try {
        signalProcessGroup(turn.pid, name);
      } catch {}
    });

  const finish = Effect.fn("DetachedAgentTurns.finish")(function* (turn: DetachedAgentTurn) {
    tracked.delete(turn.outputDir);
    if (turn.unit !== undefined) yield* agentScope.stop(turn.unit);
    yield* removeDir(turn.outputDir);
  });

  const kill = Effect.fn("DetachedAgentTurns.kill")(function* (turn: DetachedAgentTurn) {
    tracked.delete(turn.outputDir);
    if (yield* alive(turn)) {
      yield* signal(turn, "SIGTERM");
      yield* Effect.sleep(KILL_GRACE).pipe(
        Effect.andThen(alive(turn)),
        Effect.flatMap((live) => (live ? signal(turn, "SIGKILL") : Effect.void)),
        Effect.andThen(finish(turn)),
        Effect.forkIn(layerScope),
      );
      return;
    }
    yield* finish(turn);
  });

  // Adopt only what the previous server detached; anything else here is output of a CLI it stopped.
  for (const entry of yield* fileSystem.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    const outputDir = path.join(root, entry);
    const record = yield* fileSystem
      .readFileString(path.join(outputDir, RECORD_FILE))
      .pipe(Effect.flatMap(decodeRecord), Effect.option);
    if (record._tag === "None") {
      yield* removeDir(outputDir);
      continue;
    }
    const turn: DetachedAgentTurn = {
      ...record.value,
      outputDir,
      stdoutPath: path.join(outputDir, DETACHED_STDOUT_FILE),
    };
    const previous = pending.get(turn.nativeThreadId);
    if ((yield* isAdoptable(turn)) && previous === undefined) {
      pending.set(turn.nativeThreadId, turn);
      yield* Effect.logInfo("Found an agent turn that kept running through a restart", {
        threadId: turn.threadId,
        runId: turn.runId,
      });
    } else {
      yield* kill(turn);
    }
  }

  if (pending.size > 0) {
    yield* Effect.sleep(UNCLAIMED_DEADLINE).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const unclaimed = [...pending.values()];
          pending.clear();
          return Effect.forEach(
            unclaimed,
            (turn) =>
              Effect.logWarning("Stopping an agent turn no thread adopted after a restart", {
                threadId: turn.threadId,
                runId: turn.runId,
              }).pipe(Effect.andThen(kill(turn))),
            { discard: true },
          );
        }),
      ),
      Effect.forkIn(layerScope),
    );
  }

  return DetachedAgentTurns.of({
    allocate: Effect.gen(function* () {
      const dir = path.join(root, yield* random.uuidV4());
      return yield* fileSystem.makeDirectory(dir, { recursive: true }).pipe(
        Effect.as(dir),
        Effect.orElseSucceed(() => undefined),
      );
    }),
    track: Effect.fn("DetachedAgentTurns.track")((process: DetachableAgentProcess) =>
      Effect.sync(() => void tracked.set(process.outputDir, process)),
    ),
    release: Effect.fn("DetachedAgentTurns.release")(function* (outputDir) {
      tracked.delete(outputDir);
      yield* removeDir(outputDir);
    }),
    detach: Effect.fn("DetachedAgentTurns.detach")(function* (runIds) {
      let detached = 0;
      const detachedAt = DateTime.formatIso(yield* DateTime.now);
      for (const process of tracked.values()) {
        const runId = process.activeRunId();
        if (runId === null || !runIds.has(runId)) continue;
        const startTime = yield* startTimeOf(process.pid);
        if (startTime === undefined) continue;
        const resumeAfterUuid = process.resumeAfterUuid();
        const written = yield* encodeRecord({
          version: 1,
          driver: "claude",
          threadId: process.threadId,
          runId,
          nativeThreadId: process.nativeThreadId,
          pid: process.pid,
          startTime,
          ...(process.unit === undefined ? {} : { unit: process.unit }),
          ...(resumeAfterUuid === undefined ? {} : { resumeAfterUuid }),
          detachedAt,
        }).pipe(
          Effect.flatMap((json) =>
            fileSystem.writeFileString(path.join(process.outputDir, RECORD_FILE), json),
          ),
          Effect.option,
        );
        if (written._tag === "None") continue;
        process.detach();
        tracked.delete(process.outputDir);
        detached += 1;
      }
      return detached;
    }),
    adoptable: Effect.fn("DetachedAgentTurns.adoptable")(function* (runId) {
      const turn = [...pending.values()].find((candidate) => candidate.runId === runId);
      return turn === undefined ? false : yield* isAdoptable(turn);
    }),
    claim: Effect.fn("DetachedAgentTurns.claim")(function* ({ nativeThreadId, runId }) {
      const turn = pending.get(nativeThreadId);
      if (turn === undefined) return undefined;
      pending.delete(nativeThreadId);
      if (turn.runId === runId && (yield* isAdoptable(turn))) {
        // A crash during adoption must not adopt the same output twice.
        yield* fileSystem.remove(path.join(turn.outputDir, RECORD_FILE)).pipe(Effect.ignore);
        return turn;
      }
      yield* kill(turn);
      return undefined;
    }),
    alive,
    kill,
    finish,
  });
});

export const layer = Layer.effect(DetachedAgentTurns, make);
