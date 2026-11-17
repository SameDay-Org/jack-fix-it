import type { AndroidConfig } from "expo/config-plugins";

import appConfig, { withoutBootCompleted } from "../../../../../app.config";

type Manifest = AndroidConfig.Manifest.AndroidManifest;

const BOOT = "android.permission.RECEIVE_BOOT_COMPLETED";
const TOOLS = "http://schemas.android.com/tools";

/** The app's manifest as prebuild hands it over: a few permissions, one of them the boot one. */
const manifest = (): Manifest => ({
  manifest: {
    $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
    "uses-permission": [
      { $: { "android:name": "android.permission.INTERNET" } },
      { $: { "android:name": BOOT } },
      { $: { "android:name": "android.permission.FOREGROUND_SERVICE_LOCATION" } },
    ],
    queries: [],
    application: [],
  },
});

/** The permission entries, as name and whether the manifest merge removes it. */
const permissions = (result: Manifest) =>
  (result.manifest["uses-permission"] ?? []).map((entry) => {
    const attributes = entry.$ as Record<string, string>;
    return [attributes["android:name"], attributes["tools:node"] ?? "kept"];
  });

describe("RECEIVE_BOOT_COMPLETED is out of the merged Android manifest (#352)", () => {
  it("is declared only as removed, so no library's declaration survives the merge", () => {
    const result = withoutBootCompleted(manifest());

    expect(permissions(result)).toEqual([
      ["android.permission.INTERNET", "kept"],
      ["android.permission.FOREGROUND_SERVICE_LOCATION", "kept"],
      [BOOT, "remove"],
    ]);
    expect(result.manifest.$["xmlns:tools"]).toBe(TOOLS);
  });

  it("removes it even when the app's own manifest never declared it (expo-task-manager does)", () => {
    const bare = manifest();
    bare.manifest["uses-permission"] = [];

    expect(permissions(withoutBootCompleted(bare))).toEqual([[BOOT, "remove"]]);
  });

  it("is applied to the app's config: its Android manifest step writes the removal", async () => {
    // The returned config carries the plugin's mods next to the ExpoConfig fields.
    const config = appConfig({ config: {} } as Parameters<typeof appConfig>[0]) as ReturnType<
      typeof appConfig
    > & { mods?: { android?: { manifest?: (step: never) => Promise<unknown> } } };
    const step = config.mods?.android?.manifest;
    expect(step).toBeDefined();

    const result = (await step!({
      ...config,
      modResults: manifest(),
      modRequest: {
        platform: "android",
        modName: "manifest",
        projectRoot: ".",
        platformProjectRoot: "android",
        introspect: true,
      },
    } as never)) as { modResults: Manifest };
    expect(permissions(result.modResults)).toContainEqual([BOOT, "remove"]);
    expect(permissions(result.modResults)).not.toContainEqual([BOOT, "kept"]);
  });
});
