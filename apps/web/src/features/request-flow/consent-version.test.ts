import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { locales } from "@/i18n/config";
import { getT } from "@/i18n/server";

import { CONSENT_VERSION } from "./config";
import { requestFlowText } from "./copy";

/**
 * The consent words each version stands for (#86, as #409's): the review's consent line, its
 * Terms and Privacy links and the button it speaks of, in every language, as a SHA-256. The API
 * stores the version with each web request's contact (`consent_version`), so a version must
 * keep meaning the words that were shown. A new wording is a new version: add a line here and
 * change CONSENT_VERSION. Never edit a recorded hash.
 */
const RECORDED: Readonly<Record<string, string>> = {
  "request-contact-2026-11-19": "63807b7190299b088f56b5e60bcad81ee35b00712ec6610a3c711e614d28026b",
  // #602: the brand in the consent line became John Got It.
  "request-contact-2026-11-23": "35cce9371ec370e438d2e2c0e7f6f294b365fdc008c20f98816d72be8a470902",
};

async function shownWords(): Promise<string> {
  const words: Record<string, { consent: string; terms: string; privacy: string; send: string }> =
    {};
  for (const locale of locales) {
    const { consent, terms, privacy, send } = requestFlowText(await getT(locale)).review;
    words[locale] = { consent, terms, privacy, send };
  }
  return createHash("sha256").update(JSON.stringify(words)).digest("hex");
}

describe("the consent version (#86)", () => {
  it("names the consent words the review shows", async () => {
    expect(
      RECORDED[CONSENT_VERSION],
      "The consent words changed: record them under a new CONSENT_VERSION.",
    ).toBe(await shownWords());
  });
});
