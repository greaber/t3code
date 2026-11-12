import {
  type EnvironmentId,
  requiredScopesForServerSettingsPatch,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { environmentCatalog } from "~/connection/catalog";
import {
  getClientSettings,
  isClientSettingsHydrated,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
} from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { environmentSession, readEnvironmentScope } from "~/state/session";
import { toastManager } from "../ui/toast";
import { persistScopedSettingsPatch } from "./scopedSettings";
import { nextPreferenceWrites, type PreferenceSyncAttempts } from "./serverSettingPreferences";

const connectedAtom = Atom.make((get) =>
  [...get(environmentCatalog.catalogValueAtom).entries.keys()].flatMap((environmentId) => {
    const generation = Option.match(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      {
        onNone: () => null,
        onSome: (connection) => (connection.phase === "connected" ? connection.generation : null),
      },
    );
    const config = get(serverEnvironment.configValueAtom(environmentId));
    return generation === null || config === null
      ? []
      : [
          {
            environmentId,
            generation,
            settings: config.settings,
            managedPolicy: config.managedPolicy,
            serverVersion: config.environment.serverVersion,
            sessionReady:
              get(environmentSession.sessionStateAtom(environmentId))._tag === "Success",
          },
        ];
  }),
).pipe(Atom.withLabel("web-server-setting-preferences-connected"));

const attempts: PreferenceSyncAttempts = new Map();
const reportedFailures = new Set<string>();
let failures: ReadonlyMap<EnvironmentId, string> = new Map();
const failureListeners = new Set<() => void>();

function setFailure(environmentId: EnvironmentId, message: string | undefined) {
  if (failures.get(environmentId) === message) return;
  const next = new Map(failures);
  if (message === undefined) next.delete(environmentId);
  else next.set(environmentId, message);
  failures = next;
  for (const listener of failureListeners) listener();
}

function subscribeFailures(listener: () => void) {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}

/** Why this app's last write of its all-environment settings failed, per environment. */
export function useServerSettingPreferenceFailures(): ReadonlyMap<EnvironmentId, string> {
  return useSyncExternalStore(subscribeFailures, () => failures);
}

export const canWriteServerSettings = (environmentId: EnvironmentId, patch: ServerSettingsPatch) =>
  requiredScopesForServerSettingsPatch(patch).every((scope) =>
    readEnvironmentScope(environmentId, scope),
  );

function applyServerSettingPreferences(): void {
  if (!isClientSettingsHydrated()) return;
  const connected = appAtomRegistry.get(connectedAtom);
  const writes = nextPreferenceWrites(
    attempts,
    connected,
    getClientSettings().serverSettingPreferences,
    canWriteServerSettings,
  );
  for (const { environmentId, patch, patchKey } of writes) {
    const target = connected.find((candidate) => candidate.environmentId === environmentId)!;
    const label = readEnvironment(environmentId)?.label ?? environmentId;
    void persistScopedSettingsPatch(
      {
        clientPatch: {},
        hasClientWrite: false,
        serverWrites: [{ environmentId, label, patch, previous: target.settings }],
        unavailableReason: null,
      },
      (request) =>
        runAtomCommand(appAtomRegistry, serverEnvironment.updateSettings, request, {
          reportFailure: false,
        }),
      () => undefined,
    ).then(({ failedEnvironments }) => {
      const failed = failedEnvironments[0];
      setFailure(environmentId, failed?.message);
      const reportKey = JSON.stringify([environmentId, target.serverVersion, patchKey]);
      if (failed === undefined || reportedFailures.has(reportKey)) return;
      reportedFailures.add(reportKey);
      toastManager.add({
        type: "error",
        title: "Settings not applied",
        description: `Could not apply your all-environment settings on ${label}: ${failed.message}`,
      });
    });
  }
}

/** Applies this client's all-environment settings to each server it connects to. */
export function startServerSettingPreferencesSync(): () => void {
  const unsubscribes = [
    appAtomRegistry.subscribe(connectedAtom, applyServerSettingPreferences),
    subscribeClientSettings(applyServerSettingPreferences),
    subscribeClientSettingsHydration(applyServerSettingPreferences),
  ];
  applyServerSettingPreferences();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
