"use server";

import { locales } from "@/i18n/config";
import { ApiError, apiGet, apiPost } from "@/lib/api";

import { emailInput, phoneInput, zipInput } from "./input";
import { phoneCountryCode } from "./server";
import type {
  WaitlistError,
  WaitlistInput,
  WaitlistResult,
  ZipCheckResult,
  ZipError,
} from "./types";

// The request flow's server actions (#86). Each is a public endpoint: it checks what it is given
// as the browser did, calls the API from the server and answers with a code the page turns into
// words. Nothing a visitor typed is logged.
//
// Until the API takes the visitor's address from the web server (#86 PR A), these calls reach
// the API from the web server's address, so the API's per-address limits count every visitor
// together. The flow stays off in production until then (REQUEST_FLOW_ENABLED).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

/** Whether Jack serves the ZIP: `GET /v1/service-areas/check`. */
export async function checkZip(raw: unknown): Promise<ZipCheckResult> {
  const zip = zipInput(raw);
  if (zip === null) return { kind: "error", error: "invalid" };
  try {
    const answer = await apiGet("/v1/service-areas/check", { query: { zip }, cache: "no-store" });
    return { kind: answer.served ? "served" : "not_served", zip: answer.zip_code };
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
  try {
    await apiPost("/v1/waitlist", { ...body, category_id: categoryId });
    return { kind: "joined" };
  } catch (error) {
    // The service was switched off since the page was built: the visitor still joins.
    if (categoryId !== null && error instanceof ApiError && error.code === "invalid_category") {
      try {
        await apiPost("/v1/waitlist", body);
        return { kind: "joined" };
      } catch (retryError) {
        return waitlistError(retryError);
      }
    }
    return waitlistError(error);
  }
}
