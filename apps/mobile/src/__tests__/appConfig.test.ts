import appConfig from "../../app.config";

type Variant = "development" | "preview" | "production";

/** The config EAS builds for a variant, with APP_VARIANT set as eas.json sets it. */
function configFor(variant: Variant | undefined) {
  const before = process.env.APP_VARIANT;
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  try {
    return appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
  } finally {
    if (before === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = before;
  }
}

/** The iOS permission strings each language's InfoPlist.strings receives. */
function iosPrompts(language: "en" | "es"): Record<string, string> {
  const locales = configFor("production").locales as Record<
    string,
    { ios: Record<string, string> }
  >;
  return locales[language].ios;
}

describe("app config (#600: the app is John Got It)", () => {
  it("app config name is John Got It with the dev suffix", () => {
    expect(configFor(undefined).name).toBe("John Got It (Dev)");
    expect(configFor("development").name).toBe("John Got It (Dev)");
    expect(configFor("preview").name).toBe("John Got It (Preview)");
    expect(configFor("production").name).toBe("John Got It");
  });

  it.each([
    ["development", "com.jackfixit.app.dev"],
    ["preview", "com.jackfixit.app.preview"],
    ["production", "com.jackfixit.app"],
  ] as const)("bundle identifier and package are unchanged (%s)", (variant, appId) => {
    const config = configFor(variant);

    expect(config.ios?.bundleIdentifier).toBe(appId);
    expect(config.android?.package).toBe(appId);
    expect(config.slug).toBe("jack-fix-it");
    expect(config.scheme).toBe("jackfixit");
    expect(config.owner).toBe("johngotitcom");
    expect(config.extra?.eas).toEqual({ projectId: "dc856055-5039-4f97-aeff-dc6aea84f8c0" });
  });

  it.each(["development", "preview", "production"] as const)(
    "declares no non-exempt encryption in the iOS Info.plist (%s)",
    (variant) => {
      expect(configFor(variant).ios?.infoPlist).toEqual({
        CFBundleAllowMixedLocalizations: true,
        ITSAppUsesNonExemptEncryption: false,
      });
    },
  );

  it.each(["en", "es"] as const)("the %s iOS permission prompts name John, never Jack", (lang) => {
    const prompts = Object.values(iosPrompts(lang));

    expect(prompts).toHaveLength(4);
    for (const prompt of prompts) {
      expect(prompt).toMatch(/\bJohn\b/);
      expect(prompt).not.toMatch(/\bJack\b/);
    }
  });
});
