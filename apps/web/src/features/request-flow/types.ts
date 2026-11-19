import type { Locale } from "@/i18n/config";

/** Why a ZIP could not be checked; each has its own line in the form. */
export type ZipError = "invalid" | "rate_limited" | "unavailable";

/** The answer of the ZIP check (`checkZip`): served, not served (the waitlist), or why not. */
export type ZipCheckResult =
  | { kind: "served"; zip: string }
  | { kind: "not_served"; zip: string }
  | { kind: "error"; error: ZipError };

/** What the waitlist form sends to `joinWaitlist`: blank contact fields are left out. */
export type WaitlistInput = {
  zip: string;
  email: string;
  phone: string;
  categoryId: string | null;
  locale: Locale;
};

/** Why joining the waitlist did not go through; each has its own line in the form. */
export type WaitlistError =
  | "missing_contact"
  | "invalid_email"
  | "invalid_phone"
  | "invalid"
  | "rate_limited"
  | "unavailable";

/** On the list, the ZIP turned out to be served (the flow goes on), or why not. */
export type WaitlistResult =
  { kind: "joined" } | { kind: "zip_served" } | { kind: "error"; error: WaitlistError };

/** The flow's words, resolved on the server in the page's language (no catalog in the browser). */
export type RequestFlowText = {
  /** "Step {{current}} of {{total}}". */
  progress: string;
  back: string;
  next: string;
  /** "{{label}} (optional)". */
  optional: string;
  /** "{{length}} / {{max}}". */
  counter: string;
  /** The title of the box listing what needs a look. */
  check: string;
  zip: {
    title: string;
    support: string;
    label: string;
    hint: string;
    checking: string;
    errors: Record<ZipError, string>;
  };
  waitlist: {
    /** "We're not in {{zip}} yet"-style lines take the ZIP. */
    title: string;
    body: string;
    emailLabel: string;
    phoneLabel: string;
    contactHint: string;
    use: string;
    submit: string;
    sending: string;
    otherZip: string;
    joinedTitle: string;
    joinedBody: string;
    home: string;
    servedNow: string;
    errors: Record<WaitlistError, string>;
  };
  describe: {
    title: string;
    support: string;
    label: string;
    required: string;
    categoryLegend: string;
    categoryHint: string;
    notSure: string;
  };
  questions: {
    support: string;
    required: string;
    /** "{{min}}", "{{max}}". */
    range: string;
    /** "{{count}}". */
    tooFew: string;
    tooMany: string;
    pickUpTo: string;
  };
};
