import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ManagedPolicySummary,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forgetServerSettingPreferences,
  planServerSettingPreferencesPatch,
  recordServerSettingPreferences,
  serverSettingPreferenceDifferences,
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

  it("forgets only the keys that stop applying", () => {
    expect(
      forgetServerSettingPreferences({ idleCompaction: "off", sidebarAutoSettleOnMerge: true }, [
        "idleCompaction",
      ]),
    ).toEqual({ sidebarAutoSettleOnMerge: true });
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

describe("environments that differ from a preference", () => {
  it("lists differing environments and marks those whose policy locks the setting", () => {
    const target = (
      label: string,
      serverSettings: ServerSettings,
      policy?: ManagedPolicySummary,
    ) => ({
      environmentId: EnvironmentId.make(label),
      label,
      settings: serverSettings,
      managedPolicy: policy,
    });
    expect(
      serverSettingPreferenceDifferences(
        { idleCompaction: "off" },
        ["idleCompaction", "compactIdleThreads"],
        [
          target("Same", settings({ idleCompaction: "off" })),
          target("Different", settings()),
          target("Managed", settings(), lockedBy("idleCompaction")),
        ],
      ).map(({ label, locked }) => ({ label, locked })),
    ).toEqual([
      { label: "Different", locked: false },
      { label: "Managed", locked: true },
    ]);
  });
});
