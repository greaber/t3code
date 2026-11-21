import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import { resolveDesktopSshCliRunner } from "./desktopSshCliRunner.ts";

describe("packaged desktop SSH bootstrap", () => {
  it.each([
    ["0.1.9-grant.9.picker.2", "0.1.9-grant.9"],
    ["0.1.9-grant.10", "0.1.9-grant.10"],
    ["0.1.9-nightly.20261120.1", "0.1.9-nightly.20261120.1"],
  ])("uses the published SSH helper for %s", (appVersion, archiveVersion) => {
    expect(
      resolveDesktopSshCliRunner({
        appVersion,
        isDevelopment: false,
        devRemoteT3ServerEntryPath: Option.none(),
      }),
    ).toEqual({ archiveVersion });
  });
});
