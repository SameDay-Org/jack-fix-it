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

export type HeadlineToken = { kind: "word"; text: string } | { kind: "slot" };

export type HeadlineMeasure = {
  /** Measured width of a static word, or undefined while it is still being measured. */
  wordWidth: (text: string) => number | undefined;
  /** The rolling word's slot at its widest: the widest word plus its glued punctuation. */
  slotWidth: number;
  /** The font's own space, the gap between words. */
  space: number;
  /** The row's width. */
  maxWidth: number;
};

/**
 * Greedy line breaking of the headline with the rolling word's slot counted at its widest, so the
 * lines are the same whichever word is showing and nothing below the headline ever moves while it
 * rolls. Returns null until every width is known.
 */
export function layoutLines(
  parts: HeadlineParts,
  measure: HeadlineMeasure,
): HeadlineToken[][] | null {
  const tokens: HeadlineToken[] = [
    ...parts.before.map((text) => ({ kind: "word" as const, text })),
    { kind: "slot" as const },
    ...parts.after.map((text) => ({ kind: "word" as const, text })),
  ];
  const widths: number[] = [];
  for (const token of tokens) {
    const width = token.kind === "slot" ? measure.slotWidth : measure.wordWidth(token.text);
    if (width === undefined) return null;
    widths.push(width);
  }
  const lines: HeadlineToken[][] = [];
  let line: HeadlineToken[] = [];
  let lineWidth = 0;
  tokens.forEach((token, index) => {
    const width = widths[index];
    if (line.length > 0 && lineWidth + measure.space + width > measure.maxWidth) {
      lines.push(line);
      line = [];
      lineWidth = 0;
    }
    lineWidth = line.length === 0 ? width : lineWidth + measure.space + width;
    line.push(token);
  });
  if (line.length > 0) lines.push(line);
  return lines;
}
