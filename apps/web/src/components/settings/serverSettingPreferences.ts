import {
  type EnvironmentId,
  globalIdleCompaction,
  idleCompactionPatch,
  isManagedSettingPath,
  type ManagedPolicySummary,
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

/** A change made for all environments becomes this client's preference for its keys. */
export function recordServerSettingPreferences(
  current: ServerSettingPreferences,
  scope: Pick<ResolvedSettingsScope, "kind">,
  patch: ServerSettingsPatch,
): ServerSettingPreferences | null {
  if (scope.kind !== "all") return null;
  const next: Record<string, unknown> = { ...current };
  let recorded = false;
  for (const key of PREFERENCE_KEYS) {
    if (patch[key] === undefined) continue;
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

export interface ServerSettingPreferenceTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly settings: ServerSettings;
  readonly managedPolicy: ManagedPolicySummary | undefined;
}

/** Connected environments whose value for any of `keys` differs from the preference. */
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
            locked: differing.some((key) => isPreferenceLocked(target.managedPolicy, key)),
          },
        ];
  });
}
