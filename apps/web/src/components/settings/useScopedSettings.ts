import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectScopedServerSettingKey,
  type ServerSettingPreferences,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";

import {
  getClientSettings,
  persistClientSettingsPatch,
  persistClientSettingsUpdate,
  useMergedSettings,
} from "../../hooks/useSettings";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  createScopedSettingsWriter,
  pendingScopedWritesAtom,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  settlePendingScopedWrites,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";
import {
  recordServerSettingPreferences,
  skipBlockedPreferenceWrites,
  withoutPreferredFields,
} from "./serverSettingPreferences";
import { canWriteServerSettings } from "./serverSettingPreferencesSync";

const readSettings = (environmentId: EnvironmentId) =>
  readEnvironment(environmentId)?.serverConfig?.settings ?? null;
const writeScopedSettings = createScopedSettingsWriter(readSettings);

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  return useMergedSettings(target?.settings ?? DEFAULT_SERVER_SETTINGS, selector);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return (
    environments: Parameters<typeof writeScopedSettings>[0],
    planner: Parameters<typeof writeScopedSettings>[1],
    onFailed?: () => void,
  ) => {
    const plan = planner(environments);
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: m(msg("Setting not saved")),
        description: plan.unavailableReason,
      });
      onFailed?.();
      return;
    }
    const save = {};
    const settle = (environmentId: EnvironmentId, saved?: ServerSettings) =>
      appAtomRegistry.update(pendingScopedWritesAtom, (writes) =>
        settlePendingScopedWrites(
          writes,
          { save, environmentId },
          (id) => readSettings(id) ?? undefined,
          saved,
        ),
      );
    appAtomRegistry.update(pendingScopedWritesAtom, (writes) => [
      ...writes,
      ...plan.serverWrites.map(({ environmentId, patch }) => ({ save, environmentId, patch })),
    ]);
    void writeScopedSettings(
      environments,
      planner,
      async (request) => {
        const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
          (scope) => !readEnvironmentScope(request.environmentId, scope),
        );
        const result = missing
          ? AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: missing,
                  message: m(msg("This connection lacks permission to change these settings.")),
                }),
              ),
            )
          : await persistServer(request).catch((error: unknown) => {
              settle(request.environmentId);
              throw error;
            });
        settle(request.environmentId, result._tag === "Success" ? result.value : undefined);
        return result;
      },
      persistClientSettingsPatch,
    ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
      if (failedEnvironments.length === 0) return;
      onFailed?.();
      toastManager.add({
        type: "error",
        title:
          savedEnvironmentCount > 0
            ? m(msg("Setting saved on some environments"))
            : m(msg("Setting not saved")),
        description: [
          ...failedEnvironments.map(({ label, message }) =>
            m(msg("Could not save on {label}: {message}", { label, message })),
          ),
          ...(savedEnvironmentCount > 0
            ? [
                m(
                  msg("Saved on {environments}.", {
                    environments: savedEnvironments.map(({ label }) => label).join(", "),
                  }),
                ),
              ]
            : []),
        ].join("\n"),
      });
    });
  };
}

export function useUpdateScopedSettings() {
  const { scope, environments, deviceOnly } = useSettingsScope();
  const run = useRunScopedPlan();
  /** `onFailed` runs when any target rejects or drops the patch, so a draft can fall back. */
  return (
    requested: ScopedSettingsPatch,
    options?: {
      readonly onFailed?: () => void;
      /** Update only all-environment settings already applied everywhere, as Restore defaults does. */
      readonly onlyExistingPreferences?: boolean;
    },
  ) => {
    const preferences = getClientSettings().serverSettingPreferences;
    // A setting applied everywhere is changed under All environments, not on one environment.
    const patch =
      scope.kind === "environment" ? withoutPreferredFields(requested, preferences) : requested;
    const planner: Parameters<typeof writeScopedSettings>[1] = (current) => {
      const planned = planScopedSettingsPatch(scope, current, patch, { deviceOnly });
      return scope.kind === "all"
        ? {
            ...planned,
            serverWrites: skipBlockedPreferenceWrites(planned.serverWrites, {
              policyOf: (environmentId) =>
                environments.find((environment) => environment.environmentId === environmentId)
                  ?.serverConfig?.managedPolicy,
              canWrite: canWriteServerSettings,
            }),
          }
        : planned;
    };
    const plan = planner(environments);
    const recordOptions = { onlyExisting: options?.onlyExistingPreferences === true };
    if (
      plan.unavailableReason === null &&
      recordServerSettingPreferences(preferences, scope, patch, recordOptions)
    ) {
      updateServerSettingPreferences(
        (current) =>
          recordServerSettingPreferences(current, scope, patch, recordOptions) ?? current,
      );
    }
    run(environments, planner, options?.onFailed);
  };
}

export function updateServerSettingPreferences(
  update: (current: ServerSettingPreferences) => ServerSettingPreferences,
) {
  void persistClientSettingsUpdate((current) => ({
    ...current,
    serverSettingPreferences: update(current.serverSettingPreferences),
  })).catch(() =>
    toastManager.add({
      type: "error",
      title: m(msg("All-environment setting not saved")),
      description: m(
        msg("This app could not save which settings it applies everywhere. Try again."),
      ),
    }),
  );
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(context.environments, (current) => planScopedSettingsClear(context.scope, current, keys));
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(context.environments, (current) => planProjectOverridesClear(current, entries, keys));
  };
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
