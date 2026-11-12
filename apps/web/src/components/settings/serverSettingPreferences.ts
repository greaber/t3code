import {
  type EnvironmentId,
  globalIdleCompaction,
  idleCompactionPatch,
  isManagedSettingPath,
  type ManagedPolicySummary,
  readsIdleCompactionModes,
  type ServerSettings,
  ServerSettingPreferences,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

import type { ResolvedSettingsScope } from "./settingsScope";

export type ServerSettingPreferenceKey = keyof typeof ServerSettingPreferences.fields;

const PREFERENCE_KEYS = Object.keys(
  ServerSettingPreferences.fields,
) as ServerSettingPreferenceKey[];
const PREFERENCE_KEY_SET = new Set<string>(PREFERENCE_KEYS);

export function isServerSettingPreferenceKey(key: string): key is ServerSettingPreferenceKey {
  return PREFERENCE_KEY_SET.has(key);
}

/** The preference a server settings field belongs to; older servers keep idle compaction in `compactIdleThreads`. */
function preferenceKeyOf(field: string): ServerSettingPreferenceKey | null {
  if (field === "compactIdleThreads") return "idleCompaction";
  return isServerSettingPreferenceKey(field) ? field : null;
}

export function isCoveredSettingKey(field: string): boolean {
  return preferenceKeyOf(field) !== null;
}

/** The value a server uses, from whichever field its version stores it in. */
function serverValue(settings: ServerSettings, key: ServerSettingPreferenceKey): unknown {
  return key === "idleCompaction" ? globalIdleCompaction(settings) : settings[key];
}

function isPreferenceLocked(
  policy: ManagedPolicySummary | undefined,
  key: ServerSettingPreferenceKey,
): boolean {
  const paths = key === "idleCompaction" ? ["idleCompaction", "compactIdleThreads"] : [key];
  return paths.some((path) => isManagedSettingPath(policy, path));
}

/**
 * A change made for all environments becomes this client's preference for its keys. With
 * `onlyExisting`, as for Restore defaults, only preferences already set are updated.
 */
export function recordServerSettingPreferences(
  current: ServerSettingPreferences,
  scope: Pick<ResolvedSettingsScope, "kind">,
  patch: ServerSettingsPatch,
  options?: { readonly onlyExisting?: boolean },
): ServerSettingPreferences | null {
  if (scope.kind !== "all") return null;
  const next: Record<string, unknown> = { ...current };
  let recorded = false;
  for (const key of PREFERENCE_KEYS) {
    if (patch[key] === undefined) continue;
    if (options?.onlyExisting && current[key] === undefined) continue;
    next[key] = patch[key];
    recorded = true;
  }
  return recorded ? (next as ServerSettingPreferences) : null;
}

export function forgetServerSettingPreferences(
  current: ServerSettingPreferences,
  keys: readonly ServerSettingPreferenceKey[],
): ServerSettingPreferences {
  const next: Record<string, unknown> = { ...current };
  for (const key of keys) delete next[key];
  return next as ServerSettingPreferences;
}

/** Drops fields whose preference is set, which one environment must not change on its own. */
export function withoutPreferredFields<P extends object>(
  patch: P,
  preferences: ServerSettingPreferences,
): P {
  return Object.fromEntries(
    Object.entries(patch).filter(([field]) => {
      const key = preferenceKeyOf(field);
      return key === null || preferences[key] === undefined;
    }),
  ) as P;
}

/**
 * Under All environments, a covered setting is still saved where it can be: fields an
 * environment's policy locks are dropped, and an environment this connection cannot change
 * settings on is skipped when the write holds only covered fields.
 */
export function skipBlockedPreferenceWrites<
  W extends { readonly environmentId: EnvironmentId; readonly patch: ServerSettingsPatch },
>(
  writes: readonly W[],
  environment: {
    readonly policyOf: (environmentId: EnvironmentId) => ManagedPolicySummary | undefined;
    readonly canWrite: (environmentId: EnvironmentId, patch: ServerSettingsPatch) => boolean;
  },
): W[] {
  return writes.flatMap((write) => {
    const policy = environment.policyOf(write.environmentId);
    const fields = Object.keys(write.patch);
    const kept = fields.filter((field) => {
      const key = preferenceKeyOf(field);
      return key === null || !isPreferenceLocked(policy, key);
    });
    if (kept.length === 0) return [];
    const patch = Object.fromEntries(
      kept.map((field) => [field, write.patch[field as keyof ServerSettingsPatch]]),
    ) as ServerSettingsPatch;
    if (kept.every(isCoveredSettingKey) && !environment.canWrite(write.environmentId, patch)) {
      return [];
    }
    return [kept.length === fields.length ? write : { ...write, patch }];
  });
}

/**
 * The patch that brings one server in line with the preferences, in the form its version
 * reads. Keys its administrator locks are left alone.
 */
export function planServerSettingPreferencesPatch(
  preferences: ServerSettingPreferences,
  settings: ServerSettings,
  policy: ManagedPolicySummary | undefined,
): ServerSettingsPatch {
  const patch: ServerSettingsPatch = {};
  for (const key of PREFERENCE_KEYS) {
    const value = preferences[key];
    if (value === undefined || isPreferenceLocked(policy, key)) continue;
    if (Equal.equals(serverValue(settings, key), value)) continue;
    const write: ServerSettingsPatch =
      key === "idleCompaction"
        ? idleCompactionPatch(settings, preferences.idleCompaction!)
        : { [key]: value };
    // A server from before idle compaction modes stores "Never" as the switch it already has off.
    const unchanged = Object.entries(write).every(([field, next]) =>
      Equal.equals(settings[field as keyof ServerSettings], next),
    );
    if (!unchanged) Object.assign(patch, write);
  }
  return patch;
}

export interface PreferenceSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly generation: number;
  readonly settings: ServerSettings;
  readonly managedPolicy: ManagedPolicySummary | undefined;
  /** False until the auth session has loaded; a failed load also waits for a retry. */
  readonly sessionReady: boolean;
}

/** Patches already sent to each connected environment during its current connection. */
export type PreferenceSyncAttempts = Map<
  EnvironmentId,
  { readonly generation: number; readonly patches: Set<string> }
>;

/**
 * The writes to send now: each distinct patch at most once per connection, so failed writes
 * aren't repeated and two clients can't fight. A value changed elsewhere is set back now if
 * this connection hasn't sent that patch yet, otherwise on the next connection.
 * `connected` lists every environment connected right now; the rest are forgotten.
 */
export function nextPreferenceWrites(
  attempts: PreferenceSyncAttempts,
  connected: readonly PreferenceSyncTarget[],
  preferences: ServerSettingPreferences,
  canWrite: (environmentId: EnvironmentId, patch: ServerSettingsPatch) => boolean,
) {
  const connectedIds = new Set(connected.map((target) => target.environmentId));
  for (const environmentId of attempts.keys()) {
    if (!connectedIds.has(environmentId)) attempts.delete(environmentId);
  }
  return connected.flatMap((target) => {
    if (!target.sessionReady) return [];
    const patch = planServerSettingPreferencesPatch(
      preferences,
      target.settings,
      target.managedPolicy,
    );
    if (Object.keys(patch).length === 0 || !canWrite(target.environmentId, patch)) return [];
    const key = JSON.stringify(patch);
    let entry = attempts.get(target.environmentId);
    if (entry?.generation !== target.generation) {
      entry = { generation: target.generation, patches: new Set() };
      attempts.set(target.environmentId, entry);
    }
    if (entry.patches.has(key)) return [];
    entry.patches.add(key);
    return [{ environmentId: target.environmentId, patch, patchKey: key }];
  });
}

export interface ServerSettingPreferenceTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly settings: ServerSettings;
  readonly managedPolicy: ManagedPolicySummary | undefined;
  readonly canWrite: boolean;
  /** Why this app's last write of the preferences failed there, if it did. */
  readonly failure: string | undefined;
}

/** Why an environment's value differs from the preference. */
function differenceReason(
  target: ServerSettingPreferenceTarget,
  preferences: ServerSettingPreferences,
  differing: readonly ServerSettingPreferenceKey[],
): string {
  if (differing.some((key) => isPreferenceLocked(target.managedPolicy, key))) {
    return "managed there";
  }
  if (!target.canWrite) return "no permission to change settings";
  if (
    differing.includes("idleCompaction") &&
    preferences.idleCompaction === "off" &&
    !readsIdleCompactionModes(target.settings)
  ) {
    return "can't store Never, update T3 Code there";
  }
  return target.failure === undefined ? "not applied yet" : `not saved: ${target.failure}`;
}

/** Connected environments whose value for any of `keys` differs from the preference, and why. */
export function serverSettingPreferenceDifferences(
  preferences: ServerSettingPreferences,
  keys: readonly string[],
  targets: readonly ServerSettingPreferenceTarget[],
) {
  const followed = keys.filter(isServerSettingPreferenceKey);
  return targets.flatMap((target) => {
    const differing = followed.filter(
      (key) =>
        preferences[key] !== undefined &&
        !Equal.equals(serverValue(target.settings, key), preferences[key]),
    );
    return differing.length === 0
      ? []
      : [
          {
            environmentId: target.environmentId,
            label: target.label,
            reason: differenceReason(target, preferences, differing),
          },
        ];
  });
}
