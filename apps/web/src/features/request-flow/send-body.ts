import { locales } from "@/i18n/config";

import type { WebRequestCreate } from "./api-client";
import { utmInput } from "./attribution";
import { CONSENT_VERSION } from "./config";
import {
  CITY_MAX_LENGTH,
  dayInput,
  descriptionFits,
  emailInput,
  LINE_MAX_LENGTH,
  lineInput,
  nameInput,
  phoneInput,
  stateInput,
  utcToday,
  zipInput,
} from "./input";
import type { IntakeAnswersBody, PreferredPeriod, RequestDraft } from "./types";

// The draft the browser sends, checked again on the server and turned into the API's body
// (`POST /v1/web/requests`, #86). The browser ran the same checks: a refusal here means a page out of date or a
// hand-made call, and the visitor is asked to look over their answers.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIODS: readonly PreferredPeriod[] = ["morning", "afternoon", "evening", "flexible"];

/** The API's intake key (categories/intake.py KEY_PATTERN) and its body limit, in characters. */
const ANSWER_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const ANSWERS_MAX_LENGTH = 16_384;

function answersInput(value: unknown): IntakeAnswersBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const answers: IntakeAnswersBody = {};
  for (const [key, answer] of Object.entries(value)) {
    if (!ANSWER_KEY.test(key)) return null;
    const fits =
      (typeof answer === "number" && Number.isFinite(answer)) ||
      typeof answer === "string" ||
      typeof answer === "boolean" ||
      (Array.isArray(answer) && answer.every((item) => typeof item === "string"));
    if (!fits) return null;
    answers[key] = answer as IntakeAnswersBody[string];
  }
  // The API judges each answer against the service's questions; this only bounds the size.
  return JSON.stringify(answers).length <= ANSWERS_MAX_LENGTH ? answers : null;
}

/** The text when blank (null), or the checked value; `undefined` when it is there but wrong. */
function optional<T>(text: unknown, check: (text: string) => T | null): T | null | undefined {
  if (typeof text !== "string" || text.trim() === "") return null;
  return check(text) ?? undefined;
}

/** The API's body for `draft`, or null when any part of it would be refused. */
export function webRequestBody(
  draft: RequestDraft,
  now: Date,
  countryCode: string,
): WebRequestCreate | null {
  if (typeof draft !== "object" || draft === null) return null;
  const { address, contact } = draft;
  if (typeof address !== "object" || address === null) return null;
  if (typeof contact !== "object" || contact === null) return null;

  const zip = zipInput(draft.zip);
  const description = typeof draft.description === "string" ? draft.description.trim() : "";
  const categoryId =
    draft.categoryId === null
      ? null
      : UUID.test(String(draft.categoryId))
        ? draft.categoryId
        : undefined;
  const answers = answersInput(draft.answers);
  const line1 = lineInput(address.line1, LINE_MAX_LENGTH);
  const line2 = optional(address.line2, (text) => lineInput(text, LINE_MAX_LENGTH));
  const city = lineInput(address.city, CITY_MAX_LENGTH);
  const state = stateInput(address.state);
  const date = optional(draft.date, (text) => dayInput(text, utcToday(now)));
  const period = PERIODS.includes(draft.period) ? draft.period : undefined;
  const firstName = nameInput(contact.firstName);
  const phone = phoneInput(contact.phone, countryCode);
  const email = emailInput(contact.email);

  if (
    zip === null ||
    !descriptionFits(description) ||
    categoryId === undefined ||
    answers === null ||
    (categoryId === null && Object.keys(answers).length > 0) ||
    line1 === null ||
    line2 === undefined ||
    city === null ||
    state === null ||
    date === undefined ||
    period === undefined ||
    firstName === null ||
    phone === null ||
    email === null
  ) {
    return null;
  }

  return {
    description,
    category_id: categoryId,
    intake_answers: answers,
    address: { line1, line2, city, state, zip_code: zip },
    // A period only refines a day: without one the visitor is flexible (the API's rule).
    preferred_date: date,
    preferred_period: date === null ? null : period,
    contact: { first_name: firstName, email, phone },
    locale: locales.find((locale) => locale === draft.locale) ?? "en",
    utm: utmInput(draft.utm),
    consent_version: CONSENT_VERSION,
    // The trap field never reaches here filled (sendRequest stops there): always empty.
    website: "",
  };
}
