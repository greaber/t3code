import { type EnvironmentId, requiredScopesForServerSettingsPatch } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

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
import { planServerSettingPreferencesPatch } from "./serverSettingPreferences";

const targetsAtom = Atom.make((get) =>
  [...get(environmentCatalog.catalogValueAtom).entries.keys()].flatMap((environmentId) => {
    const generation = Option.match(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      {
        onNone: () => null,
        onSome: (connection) => (connection.phase === "connected" ? connection.generation : null),
      },
    );
    const config = get(serverEnvironment.configValueAtom(environmentId));
    // Write permission is known only once the session loads.
    const sessionLoaded =
      get(environmentSession.sessionStateAtom(environmentId))._tag !== "Initial";
    return generation === null || config === null || !sessionLoaded
      ? []
      : [{ environmentId, generation, config }];
  }),
).pipe(Atom.withLabel("web-server-setting-preferences-targets"));

const attemptedGenerations = new Map<EnvironmentId, number>();

function applyServerSettingPreferences(): void {
  if (!isClientSettingsHydrated()) return;
  const preferences = getClientSettings().serverSettingPreferences;
  for (const { environmentId, generation, config } of appAtomRegistry.get(targetsAtom)) {
    if (attemptedGenerations.get(environmentId) === generation) continue;
    attemptedGenerations.set(environmentId, generation);
    const patch = planServerSettingPreferencesPatch(
      preferences,
      config.settings,
      config.managedPolicy,
    );
    if (Object.keys(patch).length === 0) continue;
    if (
      !requiredScopesForServerSettingsPatch(patch).every((scope) =>
        readEnvironmentScope(environmentId, scope),
      )
    ) {
      continue;
    }
    const label = readEnvironment(environmentId)?.label ?? environmentId;
    void persistScopedSettingsPatch(
      {
        clientPatch: {},
        hasClientWrite: false,
        serverWrites: [{ environmentId, label, patch, previous: config.settings }],
        unavailableReason: null,
      },
      (request) =>
        runAtomCommand(appAtomRegistry, serverEnvironment.updateSettings, request, {
          reportFailure: false,
        }),
      () => undefined,
    ).then(({ failedEnvironments }) => {
      for (const failed of failedEnvironments) {
        toastManager.add({
          type: "error",
          title: "Settings not applied",
          description: `Could not apply your all-environment settings on ${failed.label}: ${failed.message}`,
        });
      }
    });
  }
}

/** Applies this client's all-environment settings to each server, once per connection. */
export function startServerSettingPreferencesSync(): () => void {
  const unsubscribes = [
    appAtomRegistry.subscribe(targetsAtom, applyServerSettingPreferences),
    subscribeClientSettings(applyServerSettingPreferences),
    subscribeClientSettingsHydration(applyServerSettingPreferences),
  ];
  applyServerSettingPreferences();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
