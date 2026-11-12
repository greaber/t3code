import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ManagedPolicySummary,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forgetServerSettingPreferences,
  nextPreferenceWrites,
  planServerSettingPreferencesPatch,
  type PreferenceSyncAttempts,
  type PreferenceSyncTarget,
  recordServerSettingPreferences,
  serverSettingPreferenceDifferences,
  skipBlockedPreferenceWrites,
  withoutPreferredFields,
} from "./serverSettingPreferences";

const settings = (overrides: Partial<ServerSettings> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  compactIdleThreads: false,
  idleCompaction: "onReturn",
  ...overrides,
});

const lockedBy = (...lockedSettings: string[]): ManagedPolicySummary => ({
  organization: "Example Corp",
  lockedSettings,
});

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");

describe("recording server setting preferences", () => {
  it("records only covered keys from a change made for all environments", () => {
    expect(
      recordServerSettingPreferences(
        { sidebarAutoSettleOnMerge: true },
        { kind: "all" },
        { idleCompaction: "off", sidebarAutoSettleAfterDays: null, snoozeLimitedThreads: true },
      ),
    ).toEqual({
      sidebarAutoSettleOnMerge: true,
      idleCompaction: "off",
      sidebarAutoSettleAfterDays: null,
    });
  });

  it("records nothing for a single environment or a change to uncovered keys", () => {
    expect(
      recordServerSettingPreferences({}, { kind: "environment" }, { idleCompaction: "off" }),
    ).toBeNull();
    expect(
      recordServerSettingPreferences({}, { kind: "all" }, { snoozeLimitedThreads: true }),
    ).toBeNull();
  });

  it("only updates existing preferences when restoring defaults", () => {
    const restore = { sidebarAutoSettleOnMerge: false, sidebarAutoSettleAfterDays: 7 };
    expect(
      recordServerSettingPreferences({ sidebarAutoSettleOnMerge: true }, { kind: "all" }, restore, {
        onlyExisting: true,
      }),
    ).toEqual({ sidebarAutoSettleOnMerge: false });
    expect(
      recordServerSettingPreferences({}, { kind: "all" }, restore, { onlyExisting: true }),
    ).toBeNull();
  });

  it("forgets only the keys that stop applying", () => {
    expect(
      forgetServerSettingPreferences({ idleCompaction: "off", sidebarAutoSettleOnMerge: true }, [
        "idleCompaction",
      ]),
    ).toEqual({ sidebarAutoSettleOnMerge: true });
  });
});

describe("writes made from Settings", () => {
  it("leave fields applied everywhere out of a single environment's write", () => {
    expect(
      withoutPreferredFields(
        {
          idleCompaction: "onReturn" as const,
          compactIdleThreads: false,
          sidebarAutoSettleOnMerge: false,
          snoozeLimitedThreads: true,
        },
        { idleCompaction: "off" },
      ),
    ).toEqual({ sidebarAutoSettleOnMerge: false, snoozeLimitedThreads: true });
  });

  it("skip what an environment's policy or this connection's permissions block under All environments", () => {
    const writes = [
      { environmentId: laptop, patch: { idleCompaction: "off" as const } },
      { environmentId: server, patch: { compactIdleThreads: false } },
      { environmentId: EnvironmentId.make("readonly"), patch: { sidebarAutoSettleOnMerge: true } },
      {
        environmentId: EnvironmentId.make("readonly"),
        patch: { sidebarAutoSettleOnMerge: true, snoozeLimitedThreads: true },
      },
    ];
    const kept = skipBlockedPreferenceWrites(writes, {
      policyOf: (environmentId) =>
        environmentId === server ? lockedBy("compactIdleThreads") : undefined,
      canWrite: (environmentId) => environmentId !== "readonly",
    });
    expect(kept.map(({ environmentId, patch }) => ({ environmentId, patch }))).toEqual([
      writes[0],
      // A write that also changes uncovered settings still goes, and reports its failure.
      writes[3],
    ]);
  });
});

describe("applying server setting preferences on connect", () => {
  const preferences = {
    idleCompaction: "off",
    sidebarAutoSettleOnMerge: true,
    sidebarAutoSettleAfterDays: 3,
  } as const;

  it("writes only the keys whose value differs", () => {
    expect(
      planServerSettingPreferencesPatch(
        preferences,
        settings({ idleCompaction: "off", sidebarAutoSettleOnMerge: true }),
        undefined,
      ),
    ).toEqual({ sidebarAutoSettleAfterDays: 3 });
    expect(
      planServerSettingPreferencesPatch(
        preferences,
        settings({
          idleCompaction: "off",
          sidebarAutoSettleOnMerge: true,
          sidebarAutoSettleAfterDays: 3,
        }),
        undefined,
      ),
    ).toEqual({});
  });

  it("gives a new server with built-in defaults every preference", () => {
    expect(planServerSettingPreferencesPatch(preferences, settings(), undefined)).toEqual(
      preferences,
    );
  });

  it("leaves keys the server's policy locks", () => {
    expect(
      planServerSettingPreferencesPatch(
        preferences,
        settings(),
        lockedBy("sidebarAutoSettleOnMerge", "compactIdleThreads"),
      ),
    ).toEqual({ sidebarAutoSettleAfterDays: 3 });
  });

  it("writes idle compaction in the form each server version reads", () => {
    const plan = (mode: "off" | "beforeCacheExpires", serverSettings: ServerSettings) =>
      planServerSettingPreferencesPatch({ idleCompaction: mode }, serverSettings, undefined);
    const { idleCompaction: _absent, ...withoutModes } = settings();
    expect(plan("off", settings())).toEqual({ idleCompaction: "off" });
    expect(plan("off", { ...withoutModes, compactIdleThreads: "onReturn" })).toEqual({
      compactIdleThreads: "off",
    });
    expect(plan("beforeCacheExpires", withoutModes)).toEqual({ compactIdleThreads: true });
    // A server with only the switch cannot store "Never", and its switch is already off.
    expect(plan("off", withoutModes)).toEqual({});
  });
});

describe("deciding when to write preferences", () => {
  const preferences = { sidebarAutoSettleOnMerge: true } as const;
  const target = (overrides: Partial<PreferenceSyncTarget> = {}): PreferenceSyncTarget => ({
    environmentId: server,
    generation: 1,
    settings: settings(),
    managedPolicy: undefined,
    sessionReady: true,
    ...overrides,
  });
  const decide = (
    attempts: PreferenceSyncAttempts,
    connected: readonly PreferenceSyncTarget[],
    prefs: Parameters<typeof nextPreferenceWrites>[2] = preferences,
    canWrite = true,
  ) => nextPreferenceWrites(attempts, connected, prefs, () => canWrite).map(({ patch }) => patch);

  it("waits for the session, including one that failed to load, and for write permission", () => {
    const attempts: PreferenceSyncAttempts = new Map();
    expect(decide(attempts, [target({ sessionReady: false })])).toEqual([]);
    expect(decide(attempts, [target()], preferences, false)).toEqual([]);
    expect(decide(attempts, [target()])).toEqual([{ sidebarAutoSettleOnMerge: true }]);
  });

  it("plans again when the fresh config arrives after a cached one", () => {
    const attempts: PreferenceSyncAttempts = new Map();
    expect(
      decide(attempts, [target({ settings: settings({ sidebarAutoSettleOnMerge: true }) })]),
    ).toEqual([]);
    expect(decide(attempts, [target()])).toEqual([{ sidebarAutoSettleOnMerge: true }]);
  });

  it("sends each patch once per connection, so a failed write is not repeated", () => {
    const attempts: PreferenceSyncAttempts = new Map();
    expect(decide(attempts, [target()])).toHaveLength(1);
    expect(decide(attempts, [target()])).toEqual([]);
    // A preference changed during the connection is a different patch.
    expect(decide(attempts, [target()], { sidebarAutoSettleAfterDays: 5 })).toEqual([
      { sidebarAutoSettleAfterDays: 5 },
    ]);
  });

  it("writes again after a reconnect, even when the new connection restarts its count", () => {
    const attempts: PreferenceSyncAttempts = new Map();
    expect(decide(attempts, [target()])).toHaveLength(1);
    expect(decide(attempts, [])).toEqual([]);
    expect(decide(attempts, [target()])).toEqual([{ sidebarAutoSettleOnMerge: true }]);
    expect(decide(attempts, [target({ generation: 2 })])).toEqual([
      { sidebarAutoSettleOnMerge: true },
    ]);
  });

  it("applies a preference saved while a server was connecting once it connects", () => {
    const attempts: PreferenceSyncAttempts = new Map();
    expect(decide(attempts, [], preferences)).toEqual([]);
    expect(decide(attempts, [target()], preferences)).toEqual([{ sidebarAutoSettleOnMerge: true }]);
  });
});

describe("environments that differ from a preference", () => {
  it("lists each differing environment with why it was not applied", () => {
    const target = (
      label: string,
      serverSettings: ServerSettings,
      extra: { policy?: ManagedPolicySummary; canWrite?: boolean; failure?: string } = {},
    ) => ({
      environmentId: EnvironmentId.make(label),
      label,
      settings: serverSettings,
      managedPolicy: extra.policy,
      canWrite: extra.canWrite ?? true,
      failure: extra.failure,
    });
    const { idleCompaction: _absent, ...switchOnly } = settings();
    expect(
      serverSettingPreferenceDifferences(
        { idleCompaction: "off" },
        ["idleCompaction", "compactIdleThreads"],
        [
          target("Same", settings({ idleCompaction: "off" })),
          target("Pending", settings()),
          target("Managed", settings(), { policy: lockedBy("idleCompaction") }),
          target("Readonly", settings(), { canWrite: false }),
          target("Old", switchOnly),
          target("Failed", settings(), { failure: "The save failed." }),
        ],
      ).map(({ label, reason }) => [label, reason]),
    ).toEqual([
      ["Pending", "not applied yet"],
      ["Managed", "managed there"],
      ["Readonly", "no permission to change settings"],
      ["Old", "can't store Never, update T3 Code there"],
      ["Failed", "not saved: The save failed."],
    ]);
  });
});
