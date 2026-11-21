import { publishedServerVersion } from "@t3tools/client-runtime/connection";
import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Option from "effect/Option";
import serverPackageJson from "../../../server/package.json" with { type: "json" };
import type { DesktopEnvironment } from "../app/DesktopEnvironment.ts";

export function resolveDesktopSshCliRunner(
  environment: Pick<
    DesktopEnvironment["Service"],
    "appVersion" | "isDevelopment" | "devRemoteT3ServerEntryPath"
  >,
  env: NodeJS.ProcessEnv,
): RemoteT3RunnerOptions {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteT3ServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange: serverPackageJson.engines.node,
    };
  }
  const releaseBaseUrl = env[CLI_RELEASE_BASE_URL_ENV]?.trim();
  return {
    ...(releaseBaseUrl ? { releaseBaseUrl } : {}),
    archiveVersion: publishedServerVersion(environment.appVersion),
  };
}
