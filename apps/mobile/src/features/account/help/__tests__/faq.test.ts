import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

import { FAQ, FAQ_SECTIONS, faqIn } from "../faq";

const CATALOGS = [
  ["en", en.help],
  ["es", es.help],
] as const;

describe("the FAQ", () => {
  it("has 14 to 16 questions, 3 or 4 in each of the four sections", () => {
    expect(FAQ_SECTIONS).toEqual(["booking", "payments", "job", "account"]);
    expect(FAQ.length).toBeGreaterThanOrEqual(14);
    expect(FAQ.length).toBeLessThanOrEqual(16);
    for (const section of FAQ_SECTIONS) {
      expect([3, 4]).toContain(faqIn(section).length);
    }
    // Every entry sits in a listed section, so none is left off the page.
    expect(FAQ_SECTIONS.flatMap(faqIn)).toEqual(FAQ);
  });

  it("names each question once, with its own keys", () => {
    expect(new Set(FAQ.map((item) => item.id)).size).toBe(FAQ.length);
    for (const { id, question, answer } of FAQ) {
      expect(question).toBe(`help.faq.${id}.question`);
      expect(answer).toBe(`help.faq.${id}.answer`);
    }
  });

  it.each(CATALOGS)("%s has a question and an answer for every entry", (_, help) => {
    for (const { id } of FAQ) {
      expect(help.faq[id].question).toEqual(expect.stringMatching(/\S/));
      expect(help.faq[id].answer).toEqual(expect.stringMatching(/\S/));
    }
    for (const section of FAQ_SECTIONS) {
      expect(help.sections[section]).toEqual(expect.stringMatching(/\S/));
    }
  });

  it.each(CATALOGS)("%s holds no question or section the page does not show", (_, help) => {
    expect(Object.keys(help.faq).sort()).toEqual(FAQ.map((item) => item.id).sort());
    expect(Object.keys(help.sections).sort()).toEqual([...FAQ_SECTIONS].sort());
  });

  // The cancellation and refund rule (#3), the take rate (#2) and the problem window (#4) are
  // open or live in settings: copy that names an amount or a length of time would state them.
  it.each(CATALOGS)("%s answers state no number, price, percentage or deadline", (_, help) => {
    const stated =
      /[\d$%]|\b(hours?|horas?|percent|por ciento|fifteen|twenty|forty|quince|veinte|cuarenta)\b/i;
    for (const { id } of FAQ) {
      expect(`${help.faq[id].question} ${help.faq[id].answer}`).not.toMatch(stated);
    }
  });

  // Legal copy rule: no insurance, labor warranty, escrow, guaranteed refund or licensing claim
  // until approved.
  it("promises nothing the legal copy rule forbids", () => {
    const text = (help: (typeof CATALOGS)[number][1]) =>
      [help.title, help.intro, ...FAQ.flatMap(({ id }) => Object.values(help.faq[id]))].join(" ");

    expect(text(en.help)).not.toMatch(
      /guarantee|insur|warrant|escrow|refund|money back|protected|licens/i,
    );
    expect(text(es.help)).not.toMatch(
      /garant|asegur|\bseguros?\b|reembols|devolvemos|fideicomiso|protegid|licenc/i,
    );
  });

  // The language is chosen in Account > Settings > Language and saved to the account (#218): the
  // answer names that path by the labels on screen, and no longer says the phone decides.
  it.each([
    ["en", en, /saved to your account/, /phone/i],
    ["es", es, /se guarda en tu cuenta/, /tel[eé]fono/i],
  ] as const)("%s sends people to the language choice in Settings", (_, catalog, saved, phone) => {
    const { answer } = catalog.help.faq.language;

    for (const label of [
      catalog.tabs.account,
      catalog.settings.title,
      catalog.settings.sections.language,
    ]) {
      expect(answer).toContain(label);
    }
    expect(answer).toMatch(saved);
    expect(answer).not.toMatch(phone);
  });

  it("sends people to the job's chat, never to a contact outside the app", () => {
    expect(en.help.faq.chat.answer).toMatch(/chat on your job page.*as soon as you've booked/);
    expect(es.help.faq.chat.answer).toMatch(/chat de la página de tu trabajo.*en cuanto reservas/);
    for (const [, help] of CATALOGS) {
      const all = FAQ.flatMap(({ id }) => Object.values(help.faq[id])).join(" ");
      expect(all).not.toMatch(/@|https?:|www\.|mailto|whatsapp/i);
    }
  });
});
