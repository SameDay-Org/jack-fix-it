// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getT } from "@/i18n/server";

import { requestFlowText } from "./copy";
import { RequestFlow, type RequestFlowProps } from "./request-flow";
import type { RequestCategory } from "./server";
import type { RequestFlowText, WaitlistInput, WaitlistResult, ZipCheckResult } from "./types";

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

beforeAll(async () => {
  TEXT = requestFlowText(await getT("en"));
});

beforeEach(() => {
  checkZip = vi.fn(async (zip: string): Promise<ZipCheckResult> => ({
    kind: "served",
    zip: zip.slice(0, 5),
  }));
  joinWaitlist = vi.fn(async (): Promise<WaitlistResult> => ({ kind: "joined" }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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
        homeHref: "/",
        checkZip,
        joinWaitlist,
        ...props,
      }),
    ),
  );
}

const text = () => container.textContent ?? "";
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
    expect(text()).toContain("Step 1 of 2");
    await served(" 33301 ");
    expect(checkZip).toHaveBeenCalledWith("33301");
    expect(heading().textContent).toBe(TEXT.describe.title);
    expect(document.activeElement).toBe(heading());
    expect(text()).toContain("Step 2 of 2");
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
    // No service picked: this is the last step built so far, so there is no Continue.
    expect(() => button(TEXT.next)).toThrow();
    await click(field("Handyman") as HTMLInputElement);
    expect(text()).toContain("Step 2 of 3");
    await click(button(TEXT.next));
    expect(document.activeElement).toBe(problems());
    expect(problems()!.textContent).toContain(TEXT.describe.required);
    await type(field(TEXT.describe.label), "   ");
    await click(button(TEXT.next));
    expect(heading().textContent).toBe(TEXT.describe.title);

    await type(field(TEXT.describe.label), "The TV needs mounting.");
    await click(button(TEXT.next));
    expect(heading().textContent).toBe("Handyman");
    expect(text()).toContain("Step 3 of 3");
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
  async function atQuestions(onComplete = vi.fn()): Promise<typeof onComplete> {
    await mount({ initialCategoryId: HANDYMAN.id, onComplete });
    await served();
    await type(field(TEXT.describe.label), "Mount a TV");
    await click(button(TEXT.next));
    return onComplete;
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
    const onComplete = await atQuestions();
    await click(button(TEXT.next));
    expect(onComplete).not.toHaveBeenCalled();
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
    expect(onComplete).not.toHaveBeenCalled();

    await type(field("How many rooms?"), "3");
    await click(field("Hang a shelf") as HTMLInputElement);
    await click(button(TEXT.next));
    expect(onComplete).toHaveBeenCalledTimes(1);
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
