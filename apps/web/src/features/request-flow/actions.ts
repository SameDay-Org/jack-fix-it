"use server";

import { headers } from "next/headers";

import { requestFlowEnabled } from "@/features/landing/config";
import { locales } from "@/i18n/config";
import { ApiError } from "@/lib/api";
import { checkFormToken, mintFormToken } from "@/lib/public-form/form-token";
import { formTimings } from "@/lib/public-form/settings";
import { forwardingHeaders } from "@/lib/public-form/visitor";

import {
  createWebRequest,
  joinWaitlist as postWaitlist,
  servedAreas,
  servedCheck,
} from "./api-client";
import { requestFlowSecrets } from "./config";
import { emailInput, phoneInput, zipInput } from "./input";
import { webRequestBody } from "./send-body";
import { phoneCountryCode } from "./server";
import type {
  SendError,
  SendInput,
  SendResult,
  WaitlistError,
  WaitlistInput,
  WaitlistResult,
  ZipCheckResult,
  ZipError,
} from "./types";

// The request flow's server actions (#86). Each is a public endpoint: it checks what it is given
// as the browser did, calls the API through the flow's one client (api-client.ts) with the
// visitor's address and the web service's key, and answers with a code the page turns into
// words. Nothing a visitor typed is logged.
//
// The flag gates each action itself, first (#483 r1): an action is reachable by a direct POST
// whatever the page renders, so with the flow off it answers "unavailable" without reading its
// input, its secrets or calling the API.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

async function forwarding(): Promise<Headers> {
  return forwardingHeaders(await headers());
}

/** The city and state of a served ZIP when one city has it, to fill in the address. */
async function placeOf(zip: string): Promise<{ city: string; state: string } | null> {
  try {
    const cities = (await servedAreas()).flatMap((region) => region.cities);
    const found = cities.filter((city) => city.zips.some((item) => item.zip_code === zip));
    return found.length === 1 ? { city: found[0]!.city, state: found[0]!.state } : null;
  } catch {
    return null;
  }
}

/** Whether Jack serves the ZIP: `GET /v1/service-areas/check`. */
export async function checkZip(raw: unknown): Promise<ZipCheckResult> {
  if (!requestFlowEnabled()) return { kind: "error", error: "unavailable" };
  const zip = zipInput(raw);
  if (zip === null) return { kind: "error", error: "invalid" };
  try {
    const answer = await servedCheck(zip, await forwarding());
    if (!answer.served) return { kind: "not_served", zip: answer.zip_code };
    const place = await placeOf(answer.zip_code);
    return {
      kind: "served",
      zip: answer.zip_code,
      city: place?.city ?? null,
      state: place?.state ?? null,
    };
  } catch (error) {
    const status = statusOf(error);
    const code: ZipError =
      status === 422 ? "invalid" : status === 429 ? "rate_limited" : "unavailable";
    return { kind: "error", error: code };
  }
}

function waitlistError(error: unknown): WaitlistResult {
  const status = statusOf(error);
  if (status === 409) return { kind: "zip_served" };
  const code: WaitlistError =
    status === 422 ? "invalid" : status === 429 ? "rate_limited" : "unavailable";
  return { kind: "error", error: code };
}

/**
 * Asks to be told when the ZIP is served: `POST /v1/waitlist`, from the web. An email, a mobile
 * number or both; a service the API no longer offers is dropped rather than failing the visitor.
 */
export async function joinWaitlist(input: WaitlistInput): Promise<WaitlistResult> {
  if (!requestFlowEnabled()) return { kind: "error", error: "unavailable" };
  const zip = zipInput(input?.zip);
  if (zip === null) return { kind: "error", error: "invalid" };
  const emailText = typeof input.email === "string" ? input.email.trim() : "";
  const phoneText = typeof input.phone === "string" ? input.phone.trim() : "";
  if (emailText === "" && phoneText === "") return { kind: "error", error: "missing_contact" };
  const email = emailText === "" ? null : emailInput(emailText);
  if (emailText !== "" && email === null) return { kind: "error", error: "invalid_email" };
  const phone = phoneText === "" ? null : phoneInput(phoneText, phoneCountryCode());
  if (phoneText !== "" && phone === null) return { kind: "error", error: "invalid_phone" };
  const locale = locales.find((value) => value === input.locale) ?? "en";
  const categoryId =
    typeof input.categoryId === "string" && UUID.test(input.categoryId) ? input.categoryId : null;

  const body = { zip_code: zip, email, phone, locale, source: "web" as const };
  const headers = await forwarding();
  try {
    await postWaitlist({ ...body, category_id: categoryId }, headers);
    return { kind: "joined" };
  } catch (error) {
    // The service was switched off since the page was built: the visitor still joins.
    if (categoryId !== null && error instanceof ApiError && error.code === "invalid_category") {
      try {
        await postWaitlist(body, headers);
        return { kind: "joined" };
      } catch (retryError) {
        return waitlistError(retryError);
      }
    }
    return waitlistError(error);
  }
}

function sendError(error: unknown): SendError {
  if (!(error instanceof ApiError)) return "unavailable";
  switch (error.status) {
    case 409:
      // out_of_area: no request, the contact is on the ZIP's waitlist. idempotency_key_reused:
      // this form already made a request (its answer was lost), and the answers changed since.
      if (error.code === "out_of_area") return "out_of_area";
      return error.code === "idempotency_key_reused" ? "duplicate" : "unavailable";
    case 422:
      if (error.code === "invalid_category") return "invalid_category";
      return error.code === "invalid_intake_answers" ? "invalid_answers" : "invalid";
    case 429:
      return "rate_limited";
    case 401:
      // This server's key is missing or wrong: a setup problem, not the visitor's. No detail.
      console.error("request_send_unauthorized");
      return "unavailable";
    default:
      return "unavailable";
  }
}

/** The refusal in the page's terms; too many tries carries the API's wait, in minutes. */
function sendFailure(error: unknown): SendResult {
  const code = sendError(error);
  const seconds = error instanceof ApiError ? error.retryAfterSeconds : null;
  if (code !== "rate_limited" || seconds === null) return { kind: "error", error: code };
  return { kind: "error", error: code, waitMinutes: Math.ceil(seconds / 60) };
}

/**
 * Sends the request (#86): the flag, the honeypot, then the form's token, then every answer
 * again, then `POST /v1/web/requests` with the token's nonce as its Idempotency-Key, the web
 * service's key and the visitor's address.
 */
export async function sendRequest(input: SendInput): Promise<SendResult> {
  if (!requestFlowEnabled()) return { kind: "error", error: "unavailable" };
  const { formSecret } = requestFlowSecrets();
  const timings = formTimings("REQUEST_FORM");
  const now = new Date();
  if (typeof input?.website !== "string") return { kind: "error", error: "invalid" };
  // Only a script fills the hidden field: nothing is sent, and it is told it was (no code).
  if (input.website !== "") {
    console.info("request_honeypot");
    return { kind: "sent", code: null };
  }
  const token = checkFormToken(input.token, formSecret, "request", now.getTime(), timings);
  if (!token.ok) {
    // Too soon: the same token goes once it is old enough. Too old (or not ours): a fresh one,
    // dated back so the visitor, who has been at it a while, can send at once.
    if (token.reason === "too_fast") return { kind: "error", error: "retry" };
    return {
      kind: "error",
      error: "stale",
      token: mintFormToken(formSecret, "request", now.getTime(), timings.minSeconds),
    };
  }
  const body = webRequestBody(input.draft, now, phoneCountryCode());
  if (body === null) return { kind: "error", error: "invalid" };
  try {
    const created = await createWebRequest(body, token.nonce, await forwarding());
    return { kind: "sent", code: created.public_code };
  } catch (error) {
    return sendFailure(error);
  }
}
