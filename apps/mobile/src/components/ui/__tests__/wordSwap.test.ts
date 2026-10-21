import { swapSequence, widthAt, wordFrame } from "../wordSwap";

const LINE = 40;
const RUN = swapSequence(5, 3, 0); // fix → clean → paint → fix

describe("word swap arithmetic", () => {
  it("a run visits the next words in order and settles on stopAt", () => {
    expect(RUN).toEqual([0, 1, 2, 0]);
    expect(swapSequence(5, 5, 0)).toEqual([0, 1, 2, 3, 4, 0]);
    expect(swapSequence(5, 3, 2)).toEqual([0, 1, 2, 2]);
    expect(swapSequence(3, 4, 0)).toEqual([0, 1, 2, 0, 0]); // wraps when there are more swaps than words
    expect(swapSequence(5, 0, 0)).toEqual([0]);
    expect(swapSequence(0, 3, 0)).toEqual([]);
  });

  it("at rest only the current word shows, in place", () => {
    expect(wordFrame(0, 0, RUN, LINE, true)).toEqual({ translateY: 0, opacity: 1 });
    expect(wordFrame(0, 1, RUN, LINE, true)).toEqual({ translateY: LINE, opacity: 0 });
    expect(wordFrame(3, 0, RUN, LINE, true)).toEqual({ translateY: 0, opacity: 1 }); // settled back
    expect(wordFrame(3, 2, RUN, LINE, true)).toEqual({ translateY: LINE, opacity: 0 });
  });

  it("mid-swap the outgoing word rises and fades while the incoming one rolls in from below", () => {
    expect(wordFrame(0.25, 0, RUN, LINE, true)).toEqual({ translateY: -10, opacity: 0.75 });
    expect(wordFrame(0.25, 1, RUN, LINE, true)).toEqual({ translateY: 30, opacity: 0.25 });
    expect(wordFrame(0.25, 2, RUN, LINE, true)).toEqual({ translateY: LINE, opacity: 0 });
    // The last swap returns to the first word, not to the fourth.
    expect(wordFrame(2.5, 2, RUN, LINE, true)).toEqual({ translateY: -20, opacity: 0.5 });
    expect(wordFrame(2.5, 0, RUN, LINE, true)).toEqual({ translateY: 20, opacity: 0.5 });
    expect(wordFrame(2.5, 3, RUN, LINE, true)).toEqual({ translateY: LINE, opacity: 0 });
  });

  it("reduce motion: no translate, opacity only", () => {
    expect(wordFrame(0.25, 0, RUN, LINE, false)).toEqual({ translateY: 0, opacity: 0.75 });
    expect(wordFrame(0.25, 1, RUN, LINE, false)).toEqual({ translateY: 0, opacity: 0.25 });
    expect(wordFrame(0.25, 2, RUN, LINE, false)).toEqual({ translateY: 0, opacity: 0 });
  });

  it("a single word, or an empty run, never moves", () => {
    expect(wordFrame(0.5, 0, swapSequence(1, 3, 0), LINE, true)).toEqual({
      translateY: 0,
      opacity: 1,
    });
    expect(wordFrame(0.5, 0, [], LINE, true)).toEqual({ translateY: 0, opacity: 1 });
    expect(wordFrame(0.5, 1, [], LINE, true)).toEqual({ translateY: 0, opacity: 0 });
  });

  it("the clip width tweens between the outgoing and incoming words", () => {
    const widths = [30, 50, 70, 90, 110];
    expect(widthAt(0, RUN, widths)).toBe(30);
    expect(widthAt(0.5, RUN, widths)).toBe(40);
    expect(widthAt(1, RUN, widths)).toBe(50);
    expect(widthAt(2.5, RUN, widths)).toBe(50); // 70 back toward 30
    expect(widthAt(3, RUN, widths)).toBe(30);
    expect(widthAt(9, RUN, widths)).toBe(30); // past the end stays settled
    expect(widthAt(0.5, RUN, [])).toBe(0);
  });
});
