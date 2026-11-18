import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Locale } from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

import { FAQ_ITEMS } from "./closing";
import { CUSTOMER_FEATURES } from "./features";
import { LegalPlaceholder } from "./legal-placeholder";
import { MEDIA_IDS } from "./media";
import { ShowcasePage } from "./showcase-page";

const CATALOGS = { en, es } as const;

/** The page's HTML with its character references turned back into characters. */
function decoded(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** What the server renders: the resource hints React hoists to the front, then the page. */
async function rendered(locale: Locale): Promise<{ hints: string; html: string }> {
  const markup = decoded(renderToStaticMarkup(await ShowcasePage({ locale })));
  const hints = /^(?:<link[^>]*>)*/.exec(markup)?.[0] ?? "";
  return { hints, html: markup.slice(hints.length) };
}

async function page(locale: Locale): Promise<string> {
  return (await rendered(locale)).html;
}

/** Every string of a nested catalog entry. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(strings);
}

/** The text of the first element that carries `id`. */
function textOf(html: string, id: string): string {
  const match = new RegExp(`<(\\w+)[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  if (!match) throw new Error(`no element with id ${id}`);
  return match[2].replace(/<[^>]+>/g, "");
}

describe("showcase page", () => {
  it("tells the whole story in English, in the page's order", async () => {
    const html = await page("en");

    expect(html).toMatch(/^<div lang="en">/);
    // One h1: the brand's line, with its key word marked up for the accent color.
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(textOf(html, "hero-title")).toBe("Whatever happens at home, we fix it.");
    expect(html).toMatch(/<span class="text-green-500">fix<\/span>/);
    expect(html).toContain("You confirm when the job is done.");

    const order = [
      "hero-title",
      "how-title",
      "pros-title",
      "soon-title",
      "faq-title",
      "final-title",
    ];
    const positions = order.map((id) => html.indexOf(`id="${id}"`));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("lists the customer's six steps in order, each with its screen", async () => {
    const html = await page("en");
    const list = /<ol[^>]*>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? "";
    const steps = list.split(/<li[ >]/).slice(1);

    expect(steps).toHaveLength(CUSTOMER_FEATURES.length);
    CUSTOMER_FEATURES.forEach((feature, index) => {
      const copy = en.showcase.features[feature.id];
      expect(steps[index]).toContain(`>${index + 1}</span>`);
      expect(steps[index]).toContain(copy.label);
      expect(steps[index]).toMatch(new RegExp(`<h3[^>]*>${copy.title}</h3>`));
      expect(steps[index]).toContain(copy.body);
      expect(steps[index]).toContain(`alt="${en.showcase.media[feature.id]}"`);
    });
    expect(CUSTOMER_FEATURES.map((feature) => feature.id)).toEqual([
      "describe",
      "quotes",
      "pay",
      "track",
      "chat",
      "reviews",
    ]);
  });

  it("shows every screen of the manifest once, each with its text alternative and its size", async () => {
    const html = await page("en");
    // The hero's phone also holds its other screens, hidden until it animates (hero.test.ts);
    // the still mascots are images too (data-pose).
    const images = (html.match(/<img[^>]*>/g) ?? []).filter(
      (tag) => !tag.includes("data-hero-screen") && !tag.includes("data-pose="),
    );

    expect(images).toHaveLength(MEDIA_IDS.length);
    for (const id of MEDIA_IDS) {
      const image = images.find((tag) => tag.includes(`alt="${en.showcase.media[id]}"`));
      expect(image, id).toBeDefined();
      expect(image).toContain(`%2Fshowcase%2Fposters%2F${id}.webp`);
      // The stated size reserves the screen's space before the file arrives.
      expect(image).toMatch(/width="640"/);
      expect(image).toMatch(/height="1280"/);
    }
    // Only the hero's screen is fetched first, with the page; the rest wait until they are
    // near the viewport.
    const eager = images.filter((tag) => !tag.includes('loading="lazy"'));
    expect(eager).toHaveLength(1);
    expect(eager[0]).toContain(`alt="${en.showcase.media.home}"`);
    expect(eager[0]).toContain('loading="eager"');
    expect(eager[0]).toContain('fetchPriority="high"');
    // React turns that one high-priority image into the page's only preload hint.
    const { hints } = await rendered("en");
    expect(hints.match(/<link/g)).toHaveLength(1);
    expect(hints).toMatch(/^<link rel="preload" as="image"[^>]*posters%2Fhome[.]webp/);
    // Each is a plain <img> with a responsive source set from the image optimizer.
    for (const image of images) expect(image).toMatch(/srcSet="\/_next\/image\?url=[^"]+ \d+w/);
  });

  it("links the header, the hero and the footer to sections that exist", async () => {
    const html = await page("en");
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);

    expect(new Set(anchors)).toEqual(new Set(["content", "top", "how", "pros", "faq", "soon"]));
    for (const anchor of new Set(anchors)) expect(html, anchor).toContain(`id="${anchor}"`);
    expect(html).toMatch(/^<div lang="en"><a href="#content"[^>]*>Skip to content<\/a>/);
  });

  it("switches language with plain links to the same page, the current one marked", async () => {
    const html = await page("en");
    const toggles = html.match(/<nav aria-label="Language"[\s\S]*?<\/nav>/g) ?? [];

    expect(toggles).toHaveLength(2); // the header and the footer
    for (const toggle of toggles) {
      expect(toggle).toMatch(
        /<a[^>]*aria-current="page"[^>]*href="\/app"[^>]*>EN<span class="sr-only"> English<\/span><\/a>/,
      );
      expect(toggle).toMatch(/<a[^>]*hrefLang="en"[^>]*lang="en"[^>]*href="\/app"/);
      expect(toggle).toMatch(
        /<a[^>]*hrefLang="es"[^>]*lang="es"[^>]*href="\/es\/app"[^>]*>ES<span class="sr-only"> Español<\/span><\/a>/,
      );
      expect(toggle.match(/aria-current/g)).toHaveLength(1);
    }
  });

  it("answers every question in a native disclosure, one open at a time", async () => {
    const html = await page("en");
    const faq = html.slice(html.indexOf('id="faq"'), html.indexOf('id="final-title"'));
    const items = faq.match(/<details[\s\S]*?<\/details>/g) ?? [];

    expect(items).toHaveLength(FAQ_ITEMS.length);
    FAQ_ITEMS.forEach((item, index) => {
      const copy = en.showcase.faq.items[item];
      // <summary> first: the browser makes it the control (Enter and Space toggle it), and
      // the answer is in the HTML whether or not the item is open.
      expect(items[index]).toMatch(/^<details name="showcase-faq"[^>]*><summary/);
      expect(items[index]).not.toContain(" open");
      expect(items[index]).toContain(copy.question);
      expect(items[index]).toContain(copy.answer);
      expect(items[index]).not.toMatch(/tabindex|role=/i);
    });
  });

  it("says the app is coming, and offers nothing that looks like a download or a sign-up", async () => {
    const html = await page("en");

    expect(textOf(html, "soon-title")).toBe("Coming soon to iPhone and Android.");
    expect(html).toContain("Coming soon to iPhone and Android</p>"); // the hero's notice
    // No store badge or link, no form: neither flow exists yet.
    expect(html).not.toMatch(/apps\.apple\.com|play\.google\.com|itms-apps|market:/);
    expect(html).not.toMatch(/<form|<input|<button/);
    const external = [...html.matchAll(/href="([^"#/][^"]*)"/g)].map((match) => match[1]);
    expect(external).toEqual([]);
  });

  it("links the footer to the legal placeholders and notes the sample data", async () => {
    const html = await page("en");
    const footer = html.slice(html.indexOf("<footer"));

    expect(footer).toMatch(/<a[^>]*href="\/terms"[^>]*>Terms of Service<\/a>/);
    expect(footer).toMatch(/<a[^>]*href="\/privacy"[^>]*>Privacy Policy<\/a>/);
    expect(footer).toContain("App screens on this page show sample data.");
    expect(footer).toContain(`© ${new Date().getFullYear()} Jack Fix It`);
  });

  it("is in Spanish under /es, with its content marked as Spanish", async () => {
    const html = await page("es");

    expect(html).toMatch(/^<div lang="es"><a href="#content"[^>]*>Saltar al contenido<\/a>/);
    expect(textOf(html, "hero-title")).toBe("Pase lo que pase en casa, lo arreglamos.");
    expect(html).toMatch(/<span class="text-green-500">arreglamos<\/span>/);
    expect(textOf(html, "how-title")).toBe("Del problema al trabajo terminado, en una sola app.");
    expect(textOf(html, "soon-title")).toBe("Muy pronto en iPhone y Android.");
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/es\/app"/);
    expect(html).toMatch(/<a[^>]*href="\/es\/terms"[^>]*>Términos de servicio<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/es\/privacy"[^>]*>Política de privacidad<\/a>/);
    expect(html).toContain(`alt="${es.showcase.media.track}"`);
    // Nothing English is left in the Spanish page.
    for (const text of ["How it works", "Coming soon", "Questions", "For pros", "Skip to"]) {
      expect(html, text).not.toContain(text);
    }
  });

  it("keeps decoration out of the accessibility tree", async () => {
    const html = await page("en");
    // Two mascots move (#404), drawn inline: the hero's wave and the thinking one beside the
    // questions. The others stand still as images of the same drawing.
    const moving = html.match(/<svg[^>]*data-pose="[^"]*"[^>]*>/g) ?? [];
    const still = html.match(/<img[^>]*data-pose="[^"]*"[^>]*>/g) ?? [];

    expect(moving.length + still.length).toBeGreaterThanOrEqual(CUSTOMER_FEATURES.length + 4);
    expect(moving.map((mascot) => /data-pose="([^"]*)"/.exec(mascot)?.[1])).toEqual([
      "wave",
      "thinking",
    ]);
    for (const mascot of moving) expect(mascot).toMatch(/data-motion="still" aria-hidden="true"/);
    for (const mascot of still) expect(mascot).toContain('alt=""');
    // Every landmark that repeats has its own name.
    for (const label of ["Page sections", "Language", "Legal"]) {
      expect(html).toContain(`<nav aria-label="${label}"`);
    }
    expect(html.match(/<main/g)).toHaveLength(1);
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html.match(/<footer/g)).toHaveLength(1);
  });
});

describe("showcase copy", () => {
  // Root AGENTS.md, "Legal copy" and "Real features only"; the brief adds: fees and the take
  // rate are not advertised. A string that breaks one of these fails here, in either language.
  const forbidden: Record<Locale, RegExp> = {
    en: /guarant|warrant|insur|escrow|refund|background check|licen[sc]ed|\bfees?\b|commission|take rate|%|\$\d/i,
    es: /garant|asegurad|seguro de|fideicomiso|reembols|antecedentes|licencia|comisi[oó]n|tarifa|cargo por|%|\$\d/i,
  };

  it.each(["en", "es"] as const)("%s promises nothing the legal copy rules forbid", (locale) => {
    for (const text of strings(CATALOGS[locale].showcase)) {
      expect(text, text).not.toMatch(forbidden[locale]);
    }
  });

  it.each(["en", "es"] as const)("%s keeps the wording the brief asks for", (locale) => {
    const copy = CATALOGS[locale].showcase;
    // What the customer does, never money held for them (the legal text rules, 2026-11-17).
    const confirm = {
      en: "You confirm when the job is done.",
      es: "Tú confirmas cuando el trabajo está terminado.",
    }[locale];

    expect(copy.hero.body).toContain(confirm);
    expect(copy.features.pay.title).toBe(
      { en: "A secure payment experience.", es: "Una experiencia de pago segura." }[locale],
    );
    // The approved phrase for help, word for word as the app has it.
    expect(copy.faq.eyebrow).toBe(
      { en: "Support when you need it", es: "Apoyo cuando lo necesites" }[locale],
    );
  });
});

describe("legal placeholder", () => {
  it.each([
    ["en", "terms", "Terms of Service", "/app", "/es/terms"],
    ["en", "privacy", "Privacy Policy", "/app", "/es/privacy"],
    ["es", "terms", "Términos de servicio", "/es/app", "/terms"],
    ["es", "privacy", "Política de privacidad", "/es/app", "/privacy"],
  ] as const)(
    "%s %s says the text is being finalized and leads back to the page",
    async (locale, document, title, back, other) => {
      const html = decoded(renderToStaticMarkup(await LegalPlaceholder({ locale, document })));
      const copy = CATALOGS[locale].showcase.legal;

      expect(html).toMatch(new RegExp(`^<div lang="${locale}"`));
      expect(html).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`));
      expect(html).toContain(copy[document].lead);
      expect(html).toContain(copy[document].body);
      expect(html).toMatch(new RegExp(`<a[^>]*href="${back}"[^>]*>[\\s\\S]*?${copy.back}</a>`));
      // The language switch goes to this same document, not to the showcase page.
      expect(html).toMatch(new RegExp(`<a[^>]*href="${other}"`));
    },
  );
});
