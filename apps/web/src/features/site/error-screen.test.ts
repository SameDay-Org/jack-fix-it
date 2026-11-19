// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React's act() expects to be told it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { location } = vi.hoisted(() => ({ location: { pathname: "/" } }));
// next/font runs in Next's compiler only: here a class name stands in for the site's font.
vi.mock("next/font/local", () => ({ default: () => ({ className: "site-font" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => location.pathname }));

import AdminLayout from "@/app/admin/layout";
import AdminError from "@/app/admin/error";
import PanelPageError from "@/app/admin/(panel)/error";
import MarketingLayout from "@/app/(marketing)/layout";
import MarketingError from "@/app/(marketing)/error";
import { getT } from "@/i18n/server";

import { type ErrorCopy, ErrorCopyProvider } from "./error-copy";
import { panelErrorCopy, siteErrorCopy } from "./error-copy-server";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.lang = "en";
});

async function show(element: ReactElement, copy: ErrorCopy | Record<"en" | "es", ErrorCopy>) {
  await act(async () => root.render(createElement(ErrorCopyProvider, { copy }, element)));
}

const buttons = () => [...container.querySelectorAll("button, a")].map((e) => e.textContent);

describe("the error screens (#462)", () => {
  it("a public page: the path's language, a retry and the way home, never the error", async () => {
    const both = {
      en: siteErrorCopy(await getT("en"), "en"),
      es: siteErrorCopy(await getT("es"), "es"),
    };
    const retry = vi.fn();

    location.pathname = "/house-cleaning";
    await show(createElement(MarketingError, { retry }), both);
    expect(container.querySelector("h1")?.textContent).toBe("This page didn't load");
    expect(buttons()).toEqual(["Try again", "Go to the home page"]);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/");

    location.pathname = "/es/painting";
    await show(createElement(MarketingError, { retry }), both);
    expect(container.querySelector("main")?.getAttribute("lang")).toBe("es");
    expect(document.documentElement.lang).toBe("es");
    expect(container.querySelector("h1")?.textContent).toBe("Esta página no cargó");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/es");

    await act(async () => container.querySelector("button")?.click());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toMatch(/ERROR|digest|Error:/);
  });

  it("the whole panel: calm words and a retry, no link into a panel that cannot load", async () => {
    location.pathname = "/admin/queue";
    await show(createElement(AdminError, { retry: vi.fn() }), panelErrorCopy(await getT("en")));

    expect(container.querySelector("[role=alert] h1")?.textContent).toBe(
      "The panel can't reach the server right now",
    );
    expect(buttons()).toEqual(["Try again"]);
  });

  it("a panel page: the staff member's language, a retry and the way back to the panel", async () => {
    location.pathname = "/admin/disputes/x";
    await show(createElement(PanelPageError, { retry: vi.fn() }), panelErrorCopy(await getT("es")));

    expect(container.querySelector("h1")?.textContent).toBe(
      "El panel no puede conectarse con el servidor ahora",
    );
    expect(buttons()).toEqual(["Volver a intentar", "Volver al panel"]);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/admin");
  });

  it("gets its words from the layouts above it, from the catalogs", async () => {
    const providerOf = (tree: ReactElement): unknown => {
      let node: ReactElement | undefined = tree;
      while (node && node.type !== ErrorCopyProvider) {
        node = (node.props as { children?: ReactElement }).children;
      }
      return (node?.props as { copy?: unknown } | undefined)?.copy;
    };

    const site = providerOf(await MarketingLayout({ children: null })) as Record<string, ErrorCopy>;
    expect(site.en.title).toBe("This page didn't load");
    expect(site.es.homeHref).toBe("/es");
    const panel = providerOf(await AdminLayout({ children: null })) as ErrorCopy;
    expect(panel.title).toBe("The panel can't reach the server right now");
  });
});
