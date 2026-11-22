import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { locales } from "@/i18n/config";
import { getT } from "@/i18n/server";

import { INTEREST_CONSENT_VERSION } from "./config";
import { interestText } from "./copy";

/**
 * The consent words each version stands for (#409, the Vault's review of #536): the line the
 * form shows, its sentence and its Privacy link, in every language, as a SHA-256. The API stores
 * the version with each email, so a version must keep meaning the words that were shown. A new
 * wording is a new version: add a line here and change INTEREST_CONSENT_VERSION. Never edit a
 * recorded hash.
 */
const RECORDED: Readonly<Record<string, string>> = {
  "interest-2026-11-19": "7f9b97b312e2e05dd534e0b56c1513902554397794fcb42867f405bee5b543de",
};

async function shownWords(): Promise<string> {
  const words: Record<string, { consent: string; privacy: string }> = {};
  for (const locale of locales) {
    const { consent, privacy } = interestText(await getT(locale));
    words[locale] = { consent, privacy };
  }
  return createHash("sha256").update(JSON.stringify(words)).digest("hex");
}

describe("the consent version (#409)", () => {
  it("names the consent words the form shows", async () => {
    expect(
      RECORDED[INTEREST_CONSENT_VERSION],
      "The consent words changed: record them under a new INTEREST_CONSENT_VERSION.",
    ).toBe(await shownWords());
  });
});
