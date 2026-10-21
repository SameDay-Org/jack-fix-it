import { swapSteps, widthAt, wordAfter, wordFrame } from "../wordSwap";

const LINE = 40;

describe("word swap arithmetic", () => {
  it("a run shows every word once and settles on stopAt", () => {
    expect(swapSteps(5, 0)).toBe(5);
    expect(wordAfter(swapSteps(5, 0), 5)).toBe(0);
    expect(swapSteps(5, 2)).toBe(7);
    expect(wordAfter(swapSteps(5, 2), 5)).toBe(2);
  });

  it("at rest only the current word shows, in place", () => {
    expect(wordFrame(0, 0, 3, LINE, true)).toEqual({ translateY: 0, opacity: 1 });
    expect(wordFrame(0, 1, 3, LINE, true)).toEqual({ translateY: LINE, opacity: 0 });
    expect(wordFrame(3, 0, 3, LINE, true)).toEqual({ translateY: 0, opacity: 1 }); // wrapped back
  });

  it("mid-swap the outgoing word rises and fades while the incoming one rolls in from below", () => {
    expect(wordFrame(0.25, 0, 3, LINE, true)).toEqual({ translateY: -10, opacity: 0.75 });
    expect(wordFrame(0.25, 1, 3, LINE, true)).toEqual({ translateY: 30, opacity: 0.25 });
    expect(wordFrame(0.25, 2, 3, LINE, true)).toEqual({ translateY: LINE, opacity: 0 });
  });

  it("reduce motion: no translate, opacity only", () => {
    expect(wordFrame(0.25, 0, 3, LINE, false)).toEqual({ translateY: 0, opacity: 0.75 });
    expect(wordFrame(0.25, 1, 3, LINE, false)).toEqual({ translateY: 0, opacity: 0.25 });
    expect(wordFrame(0.25, 2, 3, LINE, false)).toEqual({ translateY: 0, opacity: 0 });
  });

  it("a single word never moves", () => {
    expect(wordFrame(0.5, 0, 1, LINE, true)).toEqual({ translateY: 0, opacity: 1 });
  });

  it("the clip width tweens between the outgoing and incoming words", () => {
    const widths = [30, 50, 70];
    expect(widthAt(0, widths)).toBe(30);
    expect(widthAt(0.5, widths)).toBe(40);
    expect(widthAt(1, widths)).toBe(50);
    expect(widthAt(2.5, widths)).toBe(50); // 70 back toward 30
    expect(widthAt(3, widths)).toBe(30);
    expect(widthAt(0.5, [])).toBe(0);
  });
});
