import { describe, expect, it } from "vitest";

import { getT } from "./server";

describe("getT", () => {
  it("translates into the requested locale", async () => {
    const t = await getT("es");

    expect(t("brand.tagline")).toBe("Pase lo que pase en casa, lo arreglamos.");
  });

  it("keeps concurrent locales independent", async () => {
    const [tEn, tEs] = await Promise.all([getT("en"), getT("es")]);

    expect(tEn("landing.comingSoon")).toBe("Our site is on the way.");
    expect(tEs("landing.comingSoon")).toBe("Nuestro sitio está en camino.");
  });
});
