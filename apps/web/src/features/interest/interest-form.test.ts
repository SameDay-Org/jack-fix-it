// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getT } from "@/i18n/server";

import { interestText } from "./copy";
import { InterestForm } from "./interest-form";
import type { InterestInput, InterestResult, InterestText } from "./types";

// React's act() expects to be told it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let TEXT: InterestText;
let root: Root;
let container: HTMLDivElement;
let getToken: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
let join: ReturnType<typeof vi.fn<(input: InterestInput) => Promise<InterestResult>>>;

beforeAll(async () => {
  TEXT = interestText(await getT("en"));
});

beforeEach(async () => {
  getToken = vi.fn(async () => "token-1");
  join = vi.fn(async (): Promise<InterestResult> => ({ kind: "joined" }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(InterestForm, {
        locale: "en",
        text: TEXT,
        privacyHref: "/privacy",
        getToken,
        join,
      }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const email = () => document.getElementById("interest-email") as HTMLInputElement;
const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

async function type(value: string): Promise<void> {
  await act(async () => {
    email().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(email(), value);
    email().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Presses Send as a person does: the button takes the focus, then the form goes. */
async function send(): Promise<void> {
  await act(async () => {
    submitButton().focus();
    submitButton().click();
  });
}

describe("the interest form (#409)", () => {
  it("asks for its token when the visitor reaches the email, once", async () => {
    expect(getToken).not.toHaveBeenCalled();
    await type("ana@example.com");
    await act(async () => email().focus());
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("says what is wrong with the email, on the field, without sending", async () => {
    await type("ana@");
    await send();
    expect(join).not.toHaveBeenCalled();
    expect(email().getAttribute("aria-invalid")).toBe("true");
    expect(email().getAttribute("aria-describedby")).toBe("interest-hint interest-error");
    expect(document.getElementById("interest-error")?.textContent).toBe(TEXT.errors.invalid_email);
    expect(document.activeElement).toBe(email());
  });

  it("sends the token, an empty trap, the email and the language, then says it is on the list", async () => {
    await type("ana@example.com");
    await send();
    expect(join).toHaveBeenCalledWith({
      token: "token-1",
      website: "",
      email: "ana@example.com",
      locale: "en",
    });
    expect(container.querySelector("form")).toBeNull();
    const done = container.querySelector('[role="status"]')!;
    expect(done.textContent).toBe(TEXT.joined);
    expect(document.activeElement).toBe(done);
  });

  it.each(["retry", "rate_limited", "unavailable"] as const)(
    "words a %s refusal as an alert and keeps the email",
    async (error) => {
      join.mockResolvedValueOnce({ kind: "error", error });
      await type("ana@example.com");
      await send();
      const alert = container.querySelector('[role="alert"]')!;
      expect(alert.textContent).toBe(TEXT.errors[error]);
      expect(email().value).toBe("ana@example.com");
    },
  );

  it("takes the fresh token of a page left open, and sends with it next time", async () => {
    join.mockResolvedValueOnce({ kind: "error", error: "stale", token: "token-2" });
    await type("ana@example.com");
    await send();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(TEXT.errors.stale);
    await send();
    expect(join.mock.calls[1]![0].token).toBe("token-2");
  });

  it("says how long to wait after too many tries, when the API said", async () => {
    join
      .mockResolvedValueOnce({ kind: "error", error: "rate_limited", waitMinutes: 3 })
      .mockResolvedValueOnce({ kind: "error", error: "rate_limited" });
    await type("ana@example.com");
    await send();
    const alert = () => container.querySelector('[role="alert"]')?.textContent;
    expect(alert()).toBe("Too many tries from here. Try again in 3 min.");
    await send();
    expect(alert()).toBe(TEXT.errors.rate_limited);
  });

  it("asks for the token again when the first ask failed", async () => {
    // Both the ask on focus and the one at Send fail.
    getToken
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"));
    await type("ana@example.com");
    await send();
    expect(join).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(TEXT.errors.unavailable);
    await send();
    expect(getToken).toHaveBeenCalledTimes(3);
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("sends once while it waits", async () => {
    let finish: (result: InterestResult) => void = () => undefined;
    join.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await type("ana@example.com");
    await send();
    expect(container.textContent).toContain(TEXT.sending);
    await send();
    expect(join).toHaveBeenCalledTimes(1);
    await act(async () => finish({ kind: "joined" }));
  });

  it("keeps the trap away from people and shows the consent line with Privacy", () => {
    const trap = document.getElementById("interest-website") as HTMLInputElement;
    expect(trap.tabIndex).toBe(-1);
    expect(trap.autocomplete).toBe("off");
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(container.textContent).toContain(TEXT.consent);
    expect(container.querySelector('a[href="/privacy"]')?.textContent).toBe(TEXT.privacy);
  });
});

describe("the browser's side of the form", () => {
  // The secrets and the API client stay on the server: the client component imports none of
  // the server modules (a type import is erased and allowed).
  const here = dirname(fileURLToPath(import.meta.url));
  const SERVER_ONLY = [
    "./actions",
    "./api-client",
    "./config",
    "./interest-entry",
    "@/lib/public-form/form-token",
    "@/lib/public-form/settings",
    "@/lib/public-form/visitor",
  ];

  it("never imports a server module", () => {
    const clients = readdirSync(here).filter(
      (file) =>
        file.endsWith(".tsx") &&
        readFileSync(joinPath(here, file), "utf8").startsWith('"use client";'),
    );
    expect(clients).toEqual(["interest-form.tsx"]);
    for (const file of clients) {
      const source = readFileSync(joinPath(here, file), "utf8");
      const imports = [...source.matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gm)].map(
        (match) => match[1],
      );
      for (const name of imports)
        expect(SERVER_ONLY, `${file} imports ${name}`).not.toContain(name);
    }
  });
});
