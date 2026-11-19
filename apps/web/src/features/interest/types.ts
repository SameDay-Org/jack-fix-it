import type { Locale } from "@/i18n/config";

/** Why the email did not go on the list; each has its own words. */
export type InterestError = "invalid_email" | "retry" | "stale" | "rate_limited" | "unavailable";

/** On the list, or why not, with a fresh form token when the old one had to be replaced. */
export type InterestResult =
  { kind: "joined" } | { kind: "error"; error: InterestError; token?: string };

/** What the form sends: its token, the hidden trap field, the email and the page's language. */
export type InterestInput = { token: string; website: string; email: string; locale: Locale };

/** The form's words, resolved on the server in the page's language. */
export type InterestText = {
  title: string;
  hint: string;
  label: string;
  consent: string;
  privacy: string;
  submit: string;
  sending: string;
  joined: string;
  honeypot: string;
  errors: Record<InterestError, string>;
};
