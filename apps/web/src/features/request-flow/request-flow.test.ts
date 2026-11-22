// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getT } from "@/i18n/server";

import { requestFlowText } from "./copy";
import { type LaterSteps, loadLaterSteps } from "./later-steps-loader";
import { RequestFlow, type RequestFlowProps } from "./request-flow";
import type { RequestCategory } from "./server";
import type {
  RequestFlowText,
  SendInput,
  SendResult,
  WaitlistInput,
  WaitlistResult,
  ZipCheckResult,
} from "./types";

// The later steps' code comes as it does in the page; a test makes it wait or fail.
vi.mock("./later-steps-loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./later-steps-loader")>();
  return { loadLaterSteps: vi.fn(actual.loadLaterSteps) };
});
const realLoad = async (): Promise<LaterSteps> => import("./later-steps");
const offline = (): Promise<LaterSteps> => Promise.reject(new Error("offline"));

// React's act() expects to be told it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const both = { en: "", es: "" };
const label = (en: string) => ({ ...both, en, es: `ES ${en}` });

const HANDYMAN: RequestCategory = {
  id: "c-handyman",
  slug: "handyman",
  name: "Handyman",
  questions: [
    {
      type: "integer",
      key: "rooms",
      required: true,
      labels: label("How many rooms?"),
      min: 1,
      max: 10,
    },
    {
      type: "multi_choice",
      key: "tasks",
      required: false,
      labels: label("Which tasks?"),
      min_selected: 0,
      max_selected: 1,
      options: [
        { value: "tv", labels: label("Mount a TV") },
        { value: "shelf", labels: label("Hang a shelf") },
      ],
    },
    { type: "boolean", key: "pets", required: true, labels: label("Any pets at home?") },
    {
      type: "text",
      key: "notes",
      required: false,
      labels: label("<img src=x onerror=alert(1)>"),
      max_length: 100,
    },
  ],
};
const CLEANING: RequestCategory = {
  id: "c-clean",
  slug: "house-cleaning",
  name: "House cleaning",
  questions: [],
};

let TEXT: RequestFlowText;
let root: Root;
let container: HTMLDivElement;
let checkZip: ReturnType<typeof vi.fn<(zip: string) => Promise<ZipCheckResult>>>;
let joinWaitlist: ReturnType<typeof vi.fn<(input: WaitlistInput) => Promise<WaitlistResult>>>;
let sendRequest: ReturnType<typeof vi.fn<(input: SendInput) => Promise<SendResult>>>;

beforeAll(async () => {
  TEXT = requestFlowText(await getT("en"));
});

// The steps after the description load apart from the page (later-steps.ts); loaded once here,
// the flow's own import of them answers at once.
beforeAll(async () => {
  await import("./later-steps");
});

beforeEach(() => {
  vi.mocked(loadLaterSteps).mockReset().mockImplementation(realLoad);
  checkZip = vi.fn(async (zip: string): Promise<ZipCheckResult> => ({
    kind: "served",
    zip: zip.slice(0, 5),
    city: "Fort Lauderdale",
    state: "FL",
  }));
  joinWaitlist = vi.fn(async (): Promise<WaitlistResult> => ({ kind: "joined" }));
  sendRequest = vi.fn(async (): Promise<SendResult> => ({ kind: "sent", code: "JF-000124" }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.history.replaceState(null, "", "/request");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(props: Partial<RequestFlowProps> = {}): Promise<void> {
  await act(async () =>
    root.render(
      createElement(RequestFlow, {
        locale: "en",
        text: TEXT,
        categories: [HANDYMAN, CLEANING],
        initialCategoryId: null,
        countryCode: "+1",
        formToken: "token-1",
        utm: { source: "google", campaign: "launch" },
        storeLinks: null,
        appHref: "/app",
        homeHref: "/",
        termsHref: "/terms",
        privacyHref: "/privacy",
        checkZip,
        joinWaitlist,
        sendRequest,
        ...props,
      }),
    ),
  );
}

const text = () => container.textContent ?? "";
/** The screen the address names (none for the ZIP step). */
const step = () => new URLSearchParams(window.location.search).get("step");
const heading = () => container.querySelector("h2")!;
const problems = () =>
  container.querySelector<HTMLElement>('[aria-labelledby="request-problems-title"]');

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function field(name: string): HTMLInputElement | HTMLTextAreaElement {
  const tag = [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith(name));
  const target = tag?.htmlFor ? document.getElementById(tag.htmlFor) : tag?.querySelector("input");
  if (!target) throw new Error(`no field ${name}`);
  return target as HTMLInputElement | HTMLTextAreaElement;
}

async function type(target: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}

async function served(zip = "33301"): Promise<void> {
  await type(field(TEXT.zip.label), zip);
  await click(button(TEXT.next));
}

describe("the ZIP step", () => {
  it("checks the ZIP and moves to the description, its heading focused", async () => {
    await mount();
    expect(heading().textContent).toBe(TEXT.zip.title);
    expect(text()).toContain("Step 1 of 6");
    await served(" 33301 ");
    expect(checkZip).toHaveBeenCalledWith("33301");
    expect(heading().textContent).toBe(TEXT.describe.title);
    expect(document.activeElement).toBe(heading());
    expect(text()).toContain("Step 2 of 6");
  });

  it("refuses a ZIP that is not one without asking, and says so at the top and under the field", async () => {
    await mount();
    await served("3330");
    expect(checkZip).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(problems());
    expect(problems()!.querySelector('a[href="#request-zip"]')?.textContent).toBe(
      TEXT.zip.errors.invalid,
    );
    const input = field(TEXT.zip.label);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("request-zip-hint request-zip-error");
  });

  it.each(["rate_limited", "unavailable"] as const)(
    "words a %s check without blaming the field",
    async (error) => {
      checkZip.mockResolvedValueOnce({ kind: "error", error });
      await mount();
      await served();
      expect(problems()!.textContent).toContain(TEXT.zip.errors[error]);
      expect(problems()!.querySelector("a")).toBeNull();
      expect(field(TEXT.zip.label).hasAttribute("aria-invalid")).toBe(false);
    },
  );

  it("answers a failed call as unavailable, and checks once while it waits", async () => {
    let fail: (error: Error) => void = () => undefined;
    checkZip.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    await mount();
    await served();
    expect(text()).toContain(TEXT.zip.checking);
    await click(button(TEXT.next));
    expect(checkZip).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error("network")));
    expect(problems()!.textContent).toContain(TEXT.zip.errors.unavailable);
  });
});

describe("the waitlist, when the ZIP is not served", () => {
  async function notServed(): Promise<void> {
    checkZip.mockResolvedValueOnce({ kind: "not_served", zip: "99999" });
    await mount({ initialCategoryId: HANDYMAN.id });
    await served("99999");
  }

  it("offers the list for that ZIP, with no step count", async () => {
    await notServed();
    expect(heading().textContent).toBe(TEXT.waitlist.title);
    expect(document.activeElement).toBe(heading());
    expect(text()).toContain("we come to 99999");
    expect(text()).not.toMatch(/Step \d/);
  });

  it("needs an email or a number, checks them, then joins with the service picked", async () => {
    await notServed();
    await click(button(TEXT.waitlist.submit));
    expect(problems()!.textContent).toContain(TEXT.waitlist.errors.missing_contact);
    await type(field(TEXT.waitlist.phoneLabel), "555-0100");
    await click(button(TEXT.waitlist.submit));
    expect(problems()!.textContent).toContain(TEXT.waitlist.errors.invalid_phone);
    expect(joinWaitlist).not.toHaveBeenCalled();

    await type(field(TEXT.waitlist.phoneLabel), "(954) 555-0100");
    await click(button(TEXT.waitlist.submit));
    expect(joinWaitlist).toHaveBeenCalledWith({
      zip: "99999",
      email: "",
      phone: "(954) 555-0100",
      categoryId: HANDYMAN.id,
      locale: "en",
    });
    expect(heading().textContent).toBe(TEXT.waitlist.joinedTitle);
    expect(document.activeElement).toBe(heading());
    expect(container.querySelector('a[href="/"]')?.textContent).toBe(TEXT.waitlist.home);
  });

  it("goes on with the request when the ZIP turned out to be served", async () => {
    joinWaitlist.mockResolvedValueOnce({ kind: "zip_served" });
    await notServed();
    await type(field(TEXT.waitlist.emailLabel), "ana@example.com");
    await click(button(TEXT.waitlist.submit));
    expect(heading().textContent).toBe(TEXT.describe.title);
    expect(text()).toContain("Good news: Jack works in 99999 now.");
  });

  it("words a refusal, and goes back to try another ZIP", async () => {
    joinWaitlist.mockResolvedValueOnce({ kind: "error", error: "rate_limited" });
    await notServed();
    await type(field(TEXT.waitlist.emailLabel), "ana@example.com");
    await click(button(TEXT.waitlist.submit));
    expect(problems()!.textContent).toContain(TEXT.waitlist.errors.rate_limited);
    await click(button(TEXT.waitlist.otherZip));
    expect(heading().textContent).toBe(TEXT.zip.title);
    expect((field(TEXT.zip.label) as HTMLInputElement).value).toBe("99999");
  });
});

describe("the description and the service", () => {
  it("needs a description; a service with questions adds a step", async () => {
    await mount();
    await served();
    await click(field("Handyman") as HTMLInputElement);
    expect(text()).toContain("Step 2 of 7");
    await click(button(TEXT.next));
    expect(document.activeElement).toBe(problems());
    expect(problems()!.textContent).toContain(TEXT.describe.required);
    await type(field(TEXT.describe.label), "   ");
    await click(button(TEXT.next));
    expect(heading().textContent).toBe(TEXT.describe.title);

    await type(field(TEXT.describe.label), "The TV needs mounting.");
    await click(button(TEXT.next));
    expect(heading().textContent).toBe("Handyman");
    expect(text()).toContain("Step 3 of 7");
  });

  it("starts with the service a link picked, and offers Not sure", async () => {
    await mount({ initialCategoryId: CLEANING.id });
    await served();
    expect((field("House cleaning") as HTMLInputElement).checked).toBe(true);
    expect((field(TEXT.describe.notSure) as HTMLInputElement).checked).toBe(false);
  });

  it("offers no service when they could not be read", async () => {
    await mount({ categories: null });
    await served();
    expect(container.querySelector("fieldset")).toBeNull();
    expect(text()).not.toContain(TEXT.describe.categoryLegend);
  });

  it("keeps everything when going back", async () => {
    await mount();
    await served();
    await type(field(TEXT.describe.label), "Leaky faucet");
    await click(button(TEXT.back));
    expect((field(TEXT.zip.label) as HTMLInputElement).value).toBe("33301");
    await served();
    expect(field(TEXT.describe.label).value).toBe("Leaky faucet");
  });
});

describe("the service's questions", () => {
  async function atQuestions(): Promise<void> {
    await mount({ initialCategoryId: HANDYMAN.id });
    await served();
    await type(field(TEXT.describe.label), "Mount a TV");
    await click(button(TEXT.next));
  }

  it("shows each question by its type, labels as plain text", async () => {
    await atQuestions();
    expect((field("How many rooms?") as HTMLInputElement).type).toBe("number");
    expect(container.querySelectorAll('input[type="checkbox"][name="q-tasks"]')).toHaveLength(2);
    expect(text()).toContain("Which tasks? (optional)");
    expect(text()).toContain("Pick up to 1.");
    expect((field("Any pets at home?") as HTMLInputElement).type).toBe("checkbox");
    // A label from the data is text, never markup.
    expect(container.querySelector("img")).toBeNull();
    expect(text()).toContain("<img src=x onerror=alert(1)> (optional)");
  });

  it("lists what needs a look and goes on once the answers fit", async () => {
    await atQuestions();
    await click(button(TEXT.next));
    expect(heading().textContent).toBe("Handyman");
    expect(document.activeElement).toBe(problems());
    expect(problems()!.querySelector('a[href="#q-rooms"]')?.textContent).toBe(
      TEXT.questions.required,
    );

    await type(field("How many rooms?"), "12");
    await click(field("Mount a TV") as HTMLInputElement);
    await click(field("Hang a shelf") as HTMLInputElement);
    await click(button(TEXT.next));
    expect(problems()!.textContent).toContain("Enter a number from 1 to 10.");
    expect(problems()!.querySelector('a[href="#q-tasks-0"]')?.textContent).toBe("Pick up to 1.");
    expect(heading().textContent).toBe("Handyman");

    await type(field("How many rooms?"), "3");
    await click(field("Hang a shelf") as HTMLInputElement);
    await click(button(TEXT.next));
    expect(heading().textContent).toBe(TEXT.where.title);
  });

  it("keeps each service's answers apart", async () => {
    await atQuestions();
    await type(field("How many rooms?"), "4");
    await click(button(TEXT.back));
    await click(field(TEXT.describe.notSure) as HTMLInputElement);
    await click(field("Handyman") as HTMLInputElement);
    await click(button(TEXT.next));
    expect((field("How many rooms?") as HTMLInputElement).value).toBe("4");
  });
});

/** Through the description (Not sure: no questions) to the address step. */
async function atWhere(props: Partial<RequestFlowProps> = {}): Promise<void> {
  await mount(props);
  await served();
  await type(field(TEXT.describe.label), "The kitchen sink leaks.");
  await click(button(TEXT.next));
}

async function fillAddress(): Promise<void> {
  await type(field(TEXT.where.line1), "100 Las Olas Blvd");
  await type(field(`${TEXT.where.line2} (optional)`), "Apt 4");
}

async function fillContact(): Promise<void> {
  await type(field(TEXT.contact.firstName), "Ana");
  await type(field(TEXT.contact.phone), "(954) 555-0100");
  await type(field(TEXT.contact.email), "Ana@Example.com");
}

/** The whole way to the review, with a day and a time of it. */
async function atReview(props: Partial<RequestFlowProps> = {}): Promise<void> {
  await atWhere(props);
  await fillAddress();
  await click(button(TEXT.next));
  await type(field(`${TEXT.when.day} (optional)`), "2099-03-14");
  await click(field(TEXT.when.periods.morning) as HTMLInputElement);
  await click(button(TEXT.next));
  await fillContact();
  await click(button(TEXT.next));
}

describe("where the job is", () => {
  it("comes with the served city and state filled in, the ZIP shown with a way to change it", async () => {
    await atWhere();
    expect(heading().textContent).toBe(TEXT.where.title);
    expect(text()).toContain("Step 3 of 6");
    expect((field(TEXT.where.city) as HTMLInputElement).value).toBe("Fort Lauderdale");
    expect((field(TEXT.where.state) as HTMLInputElement).value).toBe("FL");
    expect(text()).toContain("ZIP code: 33301");
    await click(button(TEXT.where.changeZip));
    expect(heading().textContent).toBe(TEXT.zip.title);
  });

  it("needs a street, a city and a 2-letter state", async () => {
    await atWhere();
    await type(field(TEXT.where.city), " ");
    await type(field(TEXT.where.state), "Florida");
    await click(button(TEXT.next));
    expect(document.activeElement).toBe(problems());
    const links = [...problems()!.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["#request-line1", "#request-city", "#request-state"]);
    await fillAddress();
    await type(field(TEXT.where.city), "Fort Lauderdale");
    await type(field(TEXT.where.state), "fl");
    await click(button(TEXT.next));
    expect(heading().textContent).toBe(TEXT.when.title);
  });

  /** Back to the ZIP from the address, another ZIP, and on to the address again. */
  async function otherZip(answer: ZipCheckResult): Promise<void> {
    await click(button(TEXT.where.changeZip));
    checkZip.mockResolvedValueOnce(answer);
    await served("33101");
    await click(button(TEXT.next));
    expect(heading().textContent).toBe(TEXT.where.title);
  }
  const city = () => (field(TEXT.where.city) as HTMLInputElement).value;
  const state = () => (field(TEXT.where.state) as HTMLInputElement).value;

  it("takes the new ZIP's city and state in place of those the first one filled in", async () => {
    await atWhere();
    await otherZip({ kind: "served", zip: "33101", city: "Miami", state: "FL" });
    expect([city(), state()]).toEqual(["Miami", "FL"]);
    expect(text()).toContain("ZIP code: 33101");
  });

  it("clears what the first ZIP filled in when the new one names no city", async () => {
    await atWhere();
    await otherZip({ kind: "served", zip: "33101", city: null, state: null });
    expect([city(), state()]).toEqual(["", ""]);
  });

  it("keeps a city and a state the visitor typed", async () => {
    await atWhere();
    await type(field(TEXT.where.city), "Dania Beach");
    await type(field(TEXT.where.state), "fl");
    await otherZip({ kind: "served", zip: "33101", city: "Miami", state: "FL" });
    expect([city(), state()]).toEqual(["Dania Beach", "fl"]);
  });
});

describe("the steps that load after the description (later-steps.ts)", () => {
  it("shows Loading until their code comes, then the step with its heading focused", async () => {
    let arrive: () => void = () => undefined;
    vi.mocked(loadLaterSteps).mockImplementation(
      () => new Promise((resolve) => (arrive = () => void realLoad().then(resolve))),
    );
    await atWhere();
    expect(heading().textContent).toBe(TEXT.loading);
    expect(document.activeElement).toBe(heading());
    await act(async () => arrive());
    expect(heading().textContent).toBe(TEXT.where.title);
    expect(document.activeElement).toBe(heading());
  });

  it("asks again on reaching them when the first ask failed", async () => {
    vi.mocked(loadLaterSteps).mockImplementationOnce(offline);
    await atWhere();
    expect(loadLaterSteps).toHaveBeenCalledTimes(2);
    expect(heading().textContent).toBe(TEXT.where.title);
  });

  it("says so with a Try again when they do not come, as many times as it takes", async () => {
    vi.mocked(loadLaterSteps).mockImplementation(offline);
    await atWhere();
    expect(heading().textContent).toBe(TEXT.loadFailed.title);
    expect(document.activeElement).toBe(heading());
    expect(text()).toContain(TEXT.loadFailed.body);

    await click(button(TEXT.loadFailed.retry));
    expect(heading().textContent).toBe(TEXT.loadFailed.title);
    expect(document.activeElement).toBe(heading());

    vi.mocked(loadLaterSteps).mockImplementation(realLoad);
    await click(button(TEXT.loadFailed.retry));
    expect(loadLaterSteps).toHaveBeenCalledTimes(4);
    expect(heading().textContent).toBe(TEXT.where.title);
    expect(document.activeElement).toBe(heading());
    // Nothing typed was lost on the way.
    await click(button(TEXT.back));
    expect((field(TEXT.describe.label) as HTMLTextAreaElement).value).toBe(
      "The kitchen sink leaks.",
    );
  });
});

describe("when it suits", () => {
  it("any day by default; a day before today is refused; a time of day only with a day", async () => {
    await atWhere();
    await fillAddress();
    await click(button(TEXT.next));
    expect(container.querySelector('input[name="period"]')).toBeNull();
    expect((field(`${TEXT.when.day} (optional)`) as HTMLInputElement).min).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    await type(field(`${TEXT.when.day} (optional)`), "2000-01-01");
    await click(button(TEXT.next));
    expect(problems()!.textContent).toContain(TEXT.when.errors.day);
    await type(field(`${TEXT.when.day} (optional)`), "2099-03-14");
    expect(container.querySelectorAll('input[name="period"]')).toHaveLength(4);
    await click(button(TEXT.next));
    expect(heading().textContent).toBe(TEXT.contact.title);
  });
});

describe("how we reach the visitor", () => {
  async function atContact(): Promise<void> {
    await atWhere();
    await fillAddress();
    await click(button(TEXT.next));
    await click(button(TEXT.next));
  }

  it("needs the first name, the mobile number and the email, as the API does", async () => {
    await atContact();
    expect(container.querySelector("#request-last-name")).toBeNull();
    expect(container.querySelector('input[name="preferred"]')).toBeNull();
    await click(button(TEXT.next));
    const links = [...problems()!.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["#request-first-name", "#request-phone", "#request-email"]);
    await fillContact();
    await type(field(TEXT.contact.email), "ana@");
    await click(button(TEXT.next));
    expect(problems()!.textContent).toContain(TEXT.contact.errors.email);
    await type(field(TEXT.contact.email), "ana@example.com");
    await click(button(TEXT.next));
    expect(heading().textContent).toBe(TEXT.review.title);
  });
});

describe("the review and the send", () => {
  it("shows everything as plain text, each part with its own Edit", async () => {
    await atReview({ categories: [HANDYMAN, CLEANING] });
    expect(heading().textContent).toBe(TEXT.review.title);
    expect(text()).toContain("Step 6 of 6");
    expect(text()).toContain("The kitchen sink leaks.");
    expect(text()).toContain(`${TEXT.review.sections.service}: ${TEXT.review.notSure}`);
    expect(text()).toContain("100 Las Olas Blvd");
    expect(text()).toContain("Fort Lauderdale, FL 33301");
    expect(text()).toContain("Saturday, March 14 · Morning");
    expect(text()).toContain("Ana");
    expect(text()).toContain("(954) 555-0100");
    expect(text()).toContain("Ana@Example.com");
    expect(text()).toContain(TEXT.review.consent);
    expect(container.querySelector('a[href="/terms"]')?.textContent).toBe(TEXT.review.terms);
    expect(container.querySelector('a[href="/privacy"]')?.textContent).toBe(TEXT.review.privacy);
    const edits = [...container.querySelectorAll("button[aria-label]")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(edits).toEqual([
      TEXT.review.edit.description,
      TEXT.review.edit.address,
      TEXT.review.edit.when,
      TEXT.review.edit.contact,
    ]);
    await click(
      container.querySelector<HTMLButtonElement>(`[aria-label="${TEXT.review.edit.address}"]`)!,
    );
    expect(heading().textContent).toBe(TEXT.where.title);
  });

  it("keeps the hidden field away from people: off screen, out of the tab order, unread", async () => {
    await atReview();
    const trap = document.getElementById("request-website") as HTMLInputElement;
    expect(trap.tabIndex).toBe(-1);
    expect(trap.autocomplete).toBe("off");
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("sends the token, an empty trap and every answer, then shows the number", async () => {
    await atReview();
    await click(button(TEXT.review.send));
    expect(sendRequest).toHaveBeenCalledWith({
      token: "token-1",
      website: "",
      draft: {
        zip: "33301",
        description: "The kitchen sink leaks.",
        categoryId: null,
        answers: {},
        address: {
          line1: "100 Las Olas Blvd",
          line2: "Apt 4",
          city: "Fort Lauderdale",
          state: "FL",
        },
        date: "2099-03-14",
        period: "morning",
        contact: { firstName: "Ana", phone: "(954) 555-0100", email: "Ana@Example.com" },
        locale: "en",
        utm: { source: "google", campaign: "launch" },
      },
    });
    expect(heading().textContent).toBe(TEXT.sent.title);
    expect(document.activeElement).toBe(heading());
    expect(text()).toContain("Your request number: JF-000124");
    expect(text()).toContain(TEXT.sent.next);
    // The invitation to the app's account; no store links set: the app's page.
    expect(text()).toContain(TEXT.sent.invite);
    expect(container.querySelector('a[href="/app"]')?.textContent).toBe(TEXT.sent.seeApp);
    expect(step()).toBe("done");
  });

  it("sends a service's answers as the request's intake answers", async () => {
    await mount({ initialCategoryId: HANDYMAN.id });
    await served();
    await type(field(TEXT.describe.label), "Mount a TV");
    await click(button(TEXT.next));
    await type(field("How many rooms?"), "3");
    await click(field("Mount a TV") as HTMLInputElement);
    await click(button(TEXT.next));
    await fillAddress();
    await click(button(TEXT.next));
    await click(button(TEXT.next));
    await fillContact();
    await click(button(TEXT.next));
    expect(text()).toContain("How many rooms?3");
    expect(text()).toContain("Any pets at home?No");
    await click(button(TEXT.review.send));
    expect(sendRequest.mock.calls[0]![0].draft).toMatchObject({
      categoryId: HANDYMAN.id,
      answers: { rooms: 3, tasks: ["tv"], pets: false },
      date: "",
      period: "flexible",
    });
  });

  it("offers the app's stores once they are set", async () => {
    await atReview({
      storeLinks: { appStore: "https://apps.example/jack", playStore: "https://play.example/jack" },
    });
    await click(button(TEXT.review.send));
    expect(text()).toContain(TEXT.sent.invite);
    expect(container.querySelector('a[href="/app"]')).toBeNull();
    expect(container.querySelector('a[href="https://apps.example/jack"]')?.textContent).toBe(
      "App Store",
    );
    expect(container.querySelector('a[href="https://play.example/jack"]')?.textContent).toBe(
      "Google Play",
    );
  });

  it("shows no number when nothing was sent", async () => {
    sendRequest.mockResolvedValueOnce({ kind: "sent", code: null });
    await atReview();
    await click(button(TEXT.review.send));
    expect(heading().textContent).toBe(TEXT.sent.title);
    expect(text()).not.toContain("Your request number");
  });

  it("sends once while it waits", async () => {
    let finish: (result: SendResult) => void = () => undefined;
    sendRequest.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await atReview();
    await click(button(TEXT.review.send));
    expect(text()).toContain(TEXT.review.sending);
    await click(button(TEXT.review.send));
    expect(sendRequest).toHaveBeenCalledTimes(1);
    await act(async () => finish({ kind: "sent", code: "JF-000125" }));
    expect(text()).toContain("JF-000125");
  });

  it.each(["retry", "unavailable", "rate_limited", "duplicate", "invalid"] as const)(
    "words a %s refusal on the review and keeps every answer",
    async (error) => {
      sendRequest.mockResolvedValueOnce({ kind: "error", error });
      await atReview();
      await click(button(TEXT.review.send));
      expect(heading().textContent).toBe(TEXT.review.title);
      expect(document.activeElement).toBe(problems());
      expect(problems()!.textContent).toContain(TEXT.review.errors[error]);
      expect(problems()!.textContent).toContain(TEXT.review.failedTitle);
      expect(text()).toContain("100 Las Olas Blvd");
    },
  );

  it.each([
    [7, "Try again in 7 min."],
    [61, "Try again in 61 min."],
    [91, "Try again in about 2 h."],
    [1440, "Try again in about 24 h."],
  ])("words the API's wait of %i minutes", async (waitMinutes, wording) => {
    sendRequest.mockResolvedValueOnce({ kind: "error", error: "rate_limited", waitMinutes });
    await atReview();
    await click(button(TEXT.review.send));
    expect(problems()!.textContent).toContain(wording);
  });

  it("answers a failed call as unavailable, the answers kept", async () => {
    sendRequest.mockRejectedValueOnce(new Error("network"));
    await atReview();
    await click(button(TEXT.review.send));
    expect(problems()!.textContent).toContain(TEXT.review.errors.unavailable);
  });

  it("takes the fresh token of a page left open, and sends with it next time", async () => {
    sendRequest.mockResolvedValueOnce({ kind: "error", error: "stale", token: "token-2" });
    await atReview();
    await click(button(TEXT.review.send));
    expect(problems()!.textContent).toContain(TEXT.review.errors.stale);
    await click(button(TEXT.review.send));
    expect(sendRequest.mock.calls[1]![0].token).toBe("token-2");
    expect(heading().textContent).toBe(TEXT.sent.title);
  });

  it("drops a service the API no longer offers, back on the description", async () => {
    sendRequest.mockResolvedValueOnce({ kind: "error", error: "invalid_category" });
    await mount({ initialCategoryId: CLEANING.id });
    await served();
    await type(field(TEXT.describe.label), "Deep clean");
    await click(button(TEXT.next));
    await fillAddress();
    await click(button(TEXT.next));
    await click(button(TEXT.next));
    await fillContact();
    await click(button(TEXT.next));
    await click(button(TEXT.review.send));
    expect(heading().textContent).toBe(TEXT.describe.title);
    expect(text()).toContain(TEXT.notices.invalidCategory);
    expect((field(TEXT.describe.notSure) as HTMLInputElement).checked).toBe(true);
  });

  it("goes back to the questions when the service's questions changed (422 invalid_intake_answers)", async () => {
    sendRequest.mockResolvedValueOnce({ kind: "error", error: "invalid_answers" });
    await mount({ initialCategoryId: HANDYMAN.id });
    await served();
    await type(field(TEXT.describe.label), "Mount a TV");
    await click(button(TEXT.next));
    await type(field("How many rooms?"), "3");
    await click(button(TEXT.next));
    await fillAddress();
    await click(button(TEXT.next));
    await click(button(TEXT.next));
    await fillContact();
    await click(button(TEXT.next));
    await click(button(TEXT.review.send));
    expect(heading().textContent).toBe(HANDYMAN.name);
    expect(document.activeElement).toBe(heading());
    expect(text()).toContain(TEXT.notices.invalidAnswers);
    expect((field("How many rooms?") as HTMLInputElement).value).toBe("3");
  });

  it("goes back to the description for a service without questions (422 invalid_intake_answers)", async () => {
    sendRequest.mockResolvedValueOnce({ kind: "error", error: "invalid_answers" });
    await atReview();
    await click(button(TEXT.review.send));
    expect(heading().textContent).toBe(TEXT.describe.title);
    expect(text()).toContain(TEXT.notices.invalidAnswers);
  });

  it("says the visitor is on the waitlist when the ZIP stopped being served (409 out_of_area)", async () => {
    sendRequest.mockResolvedValueOnce({ kind: "error", error: "out_of_area" });
    await atReview();
    await click(button(TEXT.review.send));
    // The API made no request and put the contact on the list: no form to fill in again.
    expect(heading().textContent).toBe(TEXT.waitlist.joinedTitle);
    expect(document.activeElement).toBe(heading());
    expect(text()).toContain("Jack isn't taking requests in 33301 right now");
    expect(container.querySelector("form")).toBeNull();
    expect(text()).not.toContain("Your request number");
  });
});

describe("the browser's Back and Forward (#86)", () => {
  /** The browser's Back or Forward: the history moves, then the page hears popstate. */
  async function browser(direction: "back" | "forward"): Promise<void> {
    const before = window.location.href;
    await act(async () => {
      window.history[direction]();
      // jsdom moves the history in a later task: wait for the address to change, then to
      // settle (passing over a screen moves it once more).
      for (let tries = 0; tries < 200 && window.location.href === before; tries += 1) {
        await new Promise((done) => setTimeout(done, 5));
      }
      let last = "";
      while (last !== window.location.href) {
        last = window.location.href;
        await new Promise((done) => setTimeout(done, 30));
      }
    });
  }

  it("moves between the screens seen, everything kept, the heading focused", async () => {
    await mount();
    await served();
    expect(step()).toBe("describe");
    await type(field(TEXT.describe.label), "Leaky faucet");
    await click(field("Handyman") as HTMLInputElement);
    await click(button(TEXT.next));
    expect(step()).toBe("questions");

    await browser("back");
    expect(heading().textContent).toBe(TEXT.describe.title);
    expect(field(TEXT.describe.label).value).toBe("Leaky faucet");
    expect(document.activeElement).toBe(heading());

    await browser("back");
    expect(step()).toBeNull();
    expect(heading().textContent).toBe(TEXT.zip.title);
    expect((field(TEXT.zip.label) as HTMLInputElement).value).toBe("33301");

    await browser("forward");
    expect(heading().textContent).toBe(TEXT.describe.title);
    await browser("forward");
    expect(heading().textContent).toBe("Handyman");
    expect(checkZip).toHaveBeenCalledTimes(1);
  });

  it("stays put when the screen cannot show any more, and puts its address back", async () => {
    await mount();
    await served();
    await type(field(TEXT.describe.label), "Leaky faucet");
    await click(field("Handyman") as HTMLInputElement);
    await click(button(TEXT.next));
    await browser("back");
    await type(field(TEXT.describe.label), "   ");

    await browser("forward");

    // No description: the questions cannot come before it.
    expect(heading().textContent).toBe(TEXT.describe.title);
    expect(step()).toBe("describe");
  });

  it("passes over a screen that cannot show any more, going back", async () => {
    checkZip.mockResolvedValueOnce({ kind: "not_served", zip: "10001" });
    await mount();
    await served("10001");
    expect(step()).toBe("waitlist");
    await click(button(TEXT.waitlist.otherZip));
    await served("33301");
    expect(step()).toBe("describe");

    const seen: string[] = [];
    await browser("back");
    seen.push(heading().textContent ?? "");
    // The waitlist was for 10001; 33301 is served now: Back goes on to the ZIP before it.
    await browser("back");
    seen.push(heading().textContent ?? "");

    expect(seen).toEqual([TEXT.zip.title, TEXT.zip.title]);
    expect(step()).toBeNull();
  });

  it("leaves the page with Back once the request is sent, never back into it", async () => {
    window.history.replaceState(null, "", "/home");
    window.history.pushState(null, "", "/request");
    await atReview();
    await click(button(TEXT.review.send));
    expect(step()).toBe("done");

    await act(async () => {
      window.history.back();
      for (let tries = 0; tries < 400 && window.location.pathname !== "/home"; tries += 1) {
        await new Promise((done) => setTimeout(done, 5));
      }
    });

    // Every screen before the end is passed over: the review is not offered to send again.
    expect(window.location.pathname).toBe("/home");
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it("goes forward only to a step whose earlier steps still go on", async () => {
    await atWhere();
    await fillAddress();
    await click(button(TEXT.next));
    expect(step()).toBe("when");
    await browser("back");
    await type(field(TEXT.where.line1), " ");

    await browser("forward");

    // No street any more: the day cannot come before it.
    expect(heading().textContent).toBe(TEXT.where.title);
  });

  it("goes back from the waitlist to the ZIP", async () => {
    checkZip.mockResolvedValueOnce({ kind: "not_served", zip: "10001" });
    await mount();
    await served("10001");
    expect(step()).toBe("waitlist");

    await browser("back");

    expect(heading().textContent).toBe(TEXT.zip.title);
  });

  it("leaves the page with Back from the ZIP, and stays where it went", async () => {
    window.history.replaceState(null, "", "/home");
    window.history.pushState(null, "", "/request");
    await mount();

    await browser("back");
    await act(async () => new Promise((done) => setTimeout(done, 50)));

    // Another page's entry is not the flow's to handle: no step back further.
    expect(window.location.pathname).toBe("/home");
  });

  it("keeps the router's own keys on every entry it marks", async () => {
    // Next keeps its state in each entry; an entry without it makes Back reload the page.
    window.history.replaceState({ __NA: true, tree: "t" }, "", "/request");

    await mount();
    expect(window.history.state).toMatchObject({ __NA: true, tree: "t" });
    await served();

    expect(window.history.state).toMatchObject({ __NA: true, tree: "t" });
    expect(step()).toBe("describe");
  });

  it("after a reload, Back leaves past the screens of the earlier load", async () => {
    // Before the reload: the home page, then this page at the ZIP and at the description.
    window.history.replaceState(null, "", "/home");
    window.history.pushState({ jfiRequestFlow: "earlier-load" }, "", "/request");
    window.history.pushState({ jfiRequestFlow: "earlier-load" }, "", "/request?step=describe");

    await mount();
    expect(heading().textContent).toBe(TEXT.zip.title);
    await act(async () => {
      window.history.back();
      for (let tries = 0; tries < 200 && window.location.pathname !== "/home"; tries += 1) {
        await new Promise((done) => setTimeout(done, 5));
      }
    });

    // The earlier load's ZIP entry is passed over too: one Back, and the visitor is home.
    expect(window.location.pathname).toBe("/home");
  });

  it("starts at the ZIP when the address names a later screen (a reload keeps nothing)", async () => {
    window.history.replaceState(null, "", "/request?service=handyman&step=questions");

    await mount();

    expect(heading().textContent).toBe(TEXT.zip.title);
    expect(window.location.search).toBe("?service=handyman");
  });
});
