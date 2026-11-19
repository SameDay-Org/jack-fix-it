import type { Locale } from "@/i18n/config";
import { ApiError, apiTimeoutMs, apiUrl } from "@/lib/api";

// The interest list's one door to the API (#409). `POST /v1/interest` is not built yet: its
// shapes follow issue #409 (email only, an optional language and source, idempotent per email,
// the consent's version stored), written by hand below. Once the API ships them the generated
// types replace these and `joinInterestList` becomes an `apiPost`.

export const INTEREST_PATH = "/v1/interest";

/** `InterestJoin` (#409). */
export type InterestJoin = {
  email: string;
  locale: Locale;
  source: "showcase";
  consent_version: string;
};

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

/**
 * Puts the email on the list. Idempotent per email, so the answer is the same whether it was
 * already there; any 2xx is "on the list" and its body, if any, is not read. Throws ApiError on
 * a refusal, with its code.
 */
export async function joinInterestList(body: InterestJoin, forwarding: Headers): Promise<void> {
  const headers = new Headers(forwarding);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const response = await fetch(apiUrl(INTEREST_PATH), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(apiTimeoutMs()),
  });
  if (!response.ok) throw new ApiError(response.status, await errorCode(response));
}
