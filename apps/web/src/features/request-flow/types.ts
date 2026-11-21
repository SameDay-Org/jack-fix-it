import type { components } from "@jack/shared";

import type { Locale } from "@/i18n/config";

export type PreferredPeriod = components["schemas"]["PreferredPeriod"];

/** Campaign attribution: the five `utm_*` keys of the address the visitor came in by. */
export type Utm = components["schemas"]["UtmIn"];

/** Answers to a category's intake questions, by key, as the API takes them. */
export type IntakeAnswersBody = Record<string, number | string | boolean | string[]>;

/** The app's store pages, once the app is in the stores (config.ts `storeLinks`). */
export type StoreLinks = { appStore: string; playStore: string };

export type AddressDraft = { line1: string; line2: string; city: string; state: string };

/** Who the BDC calls back: the API's `contact` (all three required). */
export type ContactDraft = { firstName: string; phone: string; email: string };

/**
 * Everything the visitor gave, as the browser sends it to `sendRequest` (which checks it all
 * again). The answers are already the request's `intake_answers`: only the service's own
 * questions, blanks left out.
 */
export type RequestDraft = {
  zip: string;
  description: string;
  categoryId: string | null;
  answers: IntakeAnswersBody;
  address: AddressDraft;
  /** YYYY-MM-DD, or "" for any day. */
  date: string;
  period: PreferredPeriod;
  contact: ContactDraft;
  locale: Locale;
  utm: Utm | null;
};

/** What the review step sends: the form's token, the honeypot field and the draft. */
export type SendInput = { token: string; website: string; draft: RequestDraft };

/** Why a send did not go through; each has its own words, some send the visitor to a step. */
export type SendError =
  | "stale"
  | "retry"
  | "unavailable"
  | "rate_limited"
  | "duplicate"
  | "out_of_area"
  | "invalid_category"
  | "invalid_answers"
  | "invalid";

/**
 * Sent (with the request's code; null when the honeypot was filled: nothing was sent), or why
 * not: with a fresh form token when the old one had to be replaced, and with the API's wait in
 * minutes when there were too many tries. `out_of_area`: no request was made, and the contact
 * is on the ZIP's waitlist (the API put it there).
 */
export type SendResult =
  | { kind: "sent"; code: string | null }
  | { kind: "error"; error: SendError; token?: string; waitMinutes?: number };

/** Why a ZIP could not be checked; each has its own line in the form. */
export type ZipError = "invalid" | "rate_limited" | "unavailable";

/** The answer of the ZIP check (`checkZip`): served, not served (the waitlist), or why not. */
export type ZipCheckResult =
  | { kind: "served"; zip: string; city: string | null; state: string | null }
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
  /** While the later steps are on their way (a slow connection). */
  loading: string;
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
    /** "{{zip}}": a send refused because the ZIP is no longer served (the API joined it). */
    outOfArea: string;
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
  where: {
    title: string;
    support: string;
    line1: string;
    line2: string;
    city: string;
    state: string;
    stateHint: string;
    /** "{{zip}}". */
    zip: string;
    changeZip: string;
    errors: { line1: string; city: string; state: string };
  };
  when: {
    title: string;
    support: string;
    day: string;
    dayHint: string;
    period: string;
    periods: Record<PreferredPeriod, string>;
    errors: { day: string };
  };
  contact: {
    title: string;
    support: string;
    firstName: string;
    phone: string;
    phoneHint: string;
    email: string;
    errors: { firstName: string; phone: string; email: string };
  };
  review: {
    title: string;
    support: string;
    sections: Record<ReviewSection | "service", string>;
    /** Each Edit button's full name, e.g. "Edit the address". */
    edit: Record<ReviewSection, string>;
    editLabel: string;
    notSure: string;
    flexible: string;
    yes: string;
    no: string;
    consent: string;
    terms: string;
    privacy: string;
    honeypot: string;
    send: string;
    sending: string;
    /** The title of a refused send's box (the app's words). */
    failedTitle: string;
    errors: Record<ReviewError, string>;
    /** "{{minutes}}": too many tries, with the API's wait. */
    rateLimitedIn: string;
    /** "{{hours}}": the same, for a wait of hours. */
    rateLimitedHours: string;
  };
  sent: {
    title: string;
    /** "{{code}}". */
    code: string;
    /** Who gets in touch, and how; no time is promised. */
    next: string;
    /** The invitation to the app's account. */
    invite: string;
    appStore: string;
    playStore: string;
    seeApp: string;
    home: string;
  };
  notices: { invalidCategory: string; invalidAnswers: string };
};

/** The review's parts, each with an Edit button back to its step. */
export type ReviewSection = "description" | "answers" | "address" | "when" | "contact";

/** The refusals the review itself words (the others send the visitor to a step). */
export type ReviewError = Extract<
  SendError,
  "stale" | "retry" | "unavailable" | "rate_limited" | "duplicate" | "invalid"
>;
