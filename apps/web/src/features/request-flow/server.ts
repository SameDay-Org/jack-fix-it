import type { Locale } from "@/i18n/config";

import { activeCategories } from "./api-client";
import type { IntakeQuestion } from "./questions";

/** A service the visitor may pick, with the questions it asks (in the page's language). */
export type RequestCategory = {
  id: string;
  slug: string;
  name: string;
  questions: readonly IntakeQuestion[];
};

/**
 * The active services, from `GET /v1/categories`, or null when the API cannot be read. Then the
 * page offers no service to pick: the request can go without one (the BDC picks it), and the
 * page never makes one up.
 */
export async function loadRequestCategories(locale: Locale): Promise<RequestCategory[] | null> {
  try {
    // Read once an hour for every visitor (api-client.ts): the page itself is never cached.
    const categories = await activeCategories();
    return categories.map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.names[locale] ?? category.names.en ?? category.slug,
      questions: category.intake_questions,
    }));
  } catch {
    return null;
  }
}

/** A calling code such as +1 (ITU-T E.164: one to three digits, never starting with 0). */
const CALLING_CODE = /^\+[1-9][0-9]{0,2}$/;

/**
 * The calling code phone numbers are sent with: PHONE_COUNTRY_CODE, `+1` when unset (the app's
 * default, EXPO_PUBLIC_PHONE_COUNTRY_CODE). The API checks it against its allowed codes.
 */
export function phoneCountryCode(): string {
  const code = process.env.PHONE_COUNTRY_CODE || "+1";
  if (!CALLING_CODE.test(code)) {
    throw new Error("PHONE_COUNTRY_CODE must be a calling code such as +1");
  }
  return code;
}
