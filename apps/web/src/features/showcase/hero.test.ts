import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Locale } from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

import { HERO_SCREEN_IDS } from "./hero3d/choreography";
import { ShowcasePage } from "./showcase-page";

const CATALOGS = { en, es } as const;

/** The hero section as the server renders it, character references decoded. */
async function hero(locale: Locale): Promise<string> {
  const html = renderToStaticMarkup(await ShowcasePage({ locale }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  const match = /<section id="top"[\s\S]*?<\/section>/.exec(html);
  if (!match) throw new Error("no hero section");
  return match[0];
}

/** The opening tag of the first element whose opening tag matches `pattern`. */
function tag(html: string, pattern: RegExp): string {
  const found = (html.match(/<[a-z][^>]*>/g) ?? []).find((each) => pattern.test(each));
  if (!found) throw new Error(`no tag matching ${pattern}`);
  return found;
}

const plain = (text: string) => text.replace(/<\/?accent>/g, "");

describe("the hero", () => {
  it("is pinned for a short stretch: the section is one and a half screens taller than its stage", async () => {
    const html = await hero("en");
    const section = tag(html, /<section id="top"/);
    const stage = tag(html, /group\/hero/);
    expect(section).toContain("h-[calc(250svh-4rem)]");
    expect(stage).toContain("sticky top-16 h-[calc(100svh-4rem)]");
  });

  it("is a plain section when the page keeps still (reduced motion, no script, a short viewport)", async () => {
    const html = await hero("en");
    expect(tag(html, /<section id="top"/)).toContain("still:h-auto");
    expect(tag(html, /group\/hero/)).toContain("still:relative still:top-0 still:h-auto");
    expect(tag(html, /data-hero-canvas/)).toContain("still:hidden");
    // Turning still after the 3D phone took over (a phone rotated, reduced motion switched
    // on) brings the CSS phone back; "!" beats the group-data rule that faded it out.
    const cssPhone = tag(html, /group-data-\[gl=ready\]\/hero:opacity-0/);
    expect(cssPhone).toContain("still:opacity-100!");
  });

  it("keeps the page's one h1 for assistive tech at every beat: only its look fades", async () => {
    const html = await hero("en");
    const firstBeat = tag(
      html,
      /col-start-1 row-start-1[^"]*group-data-\[beat=1\]\/hero:invisible/,
    );
    expect(firstBeat).toContain("group-data-[beat=2]/hero:invisible");
    // The beat (with its link) leaves the tree; the h1 inside it stays visible to it, and its
    // beat's opacity keeps it out of sight.
    const h1 = tag(html, /<h1/);
    expect(h1).toContain("group-data-[beat=1]/hero:visible");
    expect(h1).toContain("group-data-[beat=2]/hero:visible");
    expect(firstBeat).toContain("group-data-[beat=1]/hero:opacity-0");
  });

  it.each(["en", "es"] as const)(
    "tells its story in three beats in %s, the page's one h1 first",
    async (locale) => {
      const html = await hero(locale);
      const copy = CATALOGS[locale].showcase.hero;
      expect(html.match(/<h1/g)).toHaveLength(1);
      // Beat 1 shows first; the two others wait hidden, and are left out when still.
      const beats = html.match(/<div class="col-start-1 row-start-1[^"]*"/g) ?? [];
      expect(beats).toHaveLength(3);
      expect(beats[0]).toContain(" visible ");
      expect(beats[0]).not.toContain("still:hidden");
      for (const later of beats.slice(1)) {
        expect(later).toContain(" invisible ");
        expect(later).toContain("still:hidden");
      }
      const text = html.replace(/<[^>]+>/g, "");
      expect(text).toContain(plain(copy.title));
      for (const beat of [copy.beats.quotes, copy.beats.pay]) {
        expect(text).toContain(plain(beat.title));
        expect(text).toContain(beat.body);
      }
      expect(text.indexOf(plain(copy.title))).toBeLessThan(
        text.indexOf(plain(copy.beats.quotes.title)),
      );
    },
  );

  it("leaves a place for the 3D phone that takes no input and says nothing to assistive tech", async () => {
    const html = await hero("en");
    const slot = tag(html, /data-hero-canvas/);
    expect(slot).toContain('aria-hidden="true"');
    expect(slot).toContain("pointer-events-none");
    // The canvas itself only comes from the browser, after the page has loaded.
    expect(html).not.toContain("<canvas");
  });

  it("holds the phone's other screens hidden, so they are fetched only when the CSS phone animates", async () => {
    const html = await hero("en");
    const screens = html.match(/<img[^>]*data-hero-screen="[^"]+"[^>]*>/g) ?? [];
    expect(screens.map((each) => /data-hero-screen="([^"]+)"/.exec(each)?.[1])).toEqual(
      HERO_SCREEN_IDS.slice(1),
    );
    screens.forEach((screen, index) => {
      expect(screen).toContain('alt=""');
      expect(screen).toContain('aria-hidden="true"');
      expect(screen).toContain('loading="lazy"');
      expect(screen).not.toContain("fetchPriority");
      expect(screen).toMatch(/class="absolute inset-0 hidden /);
      expect(screen).toContain("group-data-[mode=css]/hero:block");
      expect(screen).toContain("still:hidden!"); // beats group-data-[mode=css]'s specificity
      expect(screen).toContain(`group-data-[screen=${index + 1}]/hero:opacity-100`);
      expect(screen).toContain(`%2Fshowcase%2Fposters%2F${HERO_SCREEN_IDS[index + 1]}.webp`);
    });
  });
});
