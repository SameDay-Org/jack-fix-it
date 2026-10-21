// Splits a translated sentence around its rolling word, so the pieces can be laid out as a wrapping
// row of words with the rotator in place of `{{word}}`. Punctuation glued to the word (the Spanish
// "lo {{word}}.") stays glued; everything else is a word of its own.

const PLACEHOLDER = "\u0000";

export type HeadlineParts = {
  /** Words before the rolling word. */
  before: string[];
  /** Text attached to the start of the rolling word with no space, usually empty. */
  attachedBefore: string;
  /** Text attached to the end of the rolling word with no space: "." in Spanish. */
  attachedAfter: string;
  /** Words after the rolling word. */
  after: string[];
};

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/** `render` is the catalog line with `{{word}}` interpolated: call it with the placeholder it hands you. */
export function splitHeadline(render: (word: string) => string): HeadlineParts {
  const [rawBefore = "", rawAfter = ""] = render(PLACEHOLDER).split(PLACEHOLDER);
  const attachedBefore = /\S+$/.exec(rawBefore)?.[0] ?? "";
  const attachedAfter = /^\S+/.exec(rawAfter)?.[0] ?? "";
  return {
    before: words(rawBefore.slice(0, rawBefore.length - attachedBefore.length)),
    attachedBefore,
    attachedAfter,
    after: words(rawAfter.slice(attachedAfter.length)),
  };
}
