"use server";

import { headers } from "next/headers";

import { locales } from "@/i18n/config";
import { ApiError } from "@/lib/api";
import { emailInput } from "@/lib/public-form/email";
import { checkFormToken, mintFormToken } from "@/lib/public-form/form-token";
import { formTimings } from "@/lib/public-form/settings";
import { forwardingHeaders } from "@/lib/public-form/visitor";

import { joinInterestList } from "./api-client";
import { INTEREST_CONSENT_VERSION, interestFormEnabled, interestSecrets } from "./config";
import type { InterestError, InterestInput, InterestResult } from "./types";

// The interest list's server actions (#409). Each is a public endpoint, reachable by a direct
// POST whatever the page renders: each checks the flag first and, off, does nothing. Nothing a
// visitor typed is logged.

/**
 * A token for the form, asked when the visitor first reaches it (the page is built ahead, so it
 * cannot carry one). Null while the form is off.
 */
export async function interestToken(): Promise<string | null> {
  if (!interestFormEnabled()) return null;
  return mintFormToken(interestSecrets().formSecret, "interest");
}

function joinError(error: unknown): InterestError {
  if (!(error instanceof ApiError)) return "unavailable";
  if (error.status === 422) return "invalid_email";
  if (error.status === 429) return "rate_limited";
  // This server's key is missing or wrong: a setup problem, not the visitor's. No detail.
  if (error.status === 401) console.error("interest_join_unauthorized");
  return "unavailable";
}

/**
 * Puts the email on the app-launch list (#409): the flag, the hidden trap field, the form's
 * token, the email, then `POST /v1/interest` with the visitor's address and the web key.
 */
export async function joinInterest(input: InterestInput): Promise<InterestResult> {
  if (!interestFormEnabled()) return { kind: "error", error: "unavailable" };
  const { formSecret } = interestSecrets();
  if (typeof input?.website !== "string") return { kind: "error", error: "unavailable" };
  // Only a script fills the hidden field: nothing is sent, and it is told it worked.
  if (input.website !== "") {
    console.info("interest_honeypot");
    return { kind: "joined" };
  }
  const now = Date.now();
  const timings = formTimings("INTEREST_FORM");
  const token = checkFormToken(input.token, formSecret, "interest", now, timings);
  if (!token.ok) {
    // Too soon: the same token goes once it is old enough. Too old (or not ours): a fresh one,
    // dated back so it goes at once.
    if (token.reason === "too_fast") return { kind: "error", error: "retry" };
    return {
      kind: "error",
      error: "stale",
      token: mintFormToken(formSecret, "interest", now, timings.minSeconds),
    };
  }
  const email = emailInput(input.email);
  if (email === null) return { kind: "error", error: "invalid_email" };
  const locale = locales.find((value) => value === input.locale) ?? "en";
  try {
    await joinInterestList(
      { email, locale, source: "showcase", consent_version: INTEREST_CONSENT_VERSION },
      forwardingHeaders(await headers()),
    );
    return { kind: "joined" };
  } catch (error) {
    return { kind: "error", error: joinError(error) };
  }
}
