import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Option from "effect/Option";
import serverPackageJson from "../../../server/package.json" with { type: "json" };
import type { DesktopEnvironment } from "../app/DesktopEnvironment.ts";

export function resolveDesktopSshCliRunner(
  environment: Pick<
    DesktopEnvironment["Service"],
    "appVersion" | "isDevelopment" | "devRemoteT3ServerEntryPath"
  >,
): RemoteT3RunnerOptions {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteT3ServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange: serverPackageJson.engines.node,
    };
  }
  // Picker revisions only ship the Mac app, not new remote CLI archives.
  return {
    archiveVersion: environment.appVersion.replace(
      /^(\d+\.\d+\.\d+-grant\.\d+)\.picker\.\d+$/,
      "$1",
    ),
  };
}
