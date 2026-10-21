import i18n from "@/i18n";
import { tokens } from "@/theme";

import { swapSequence } from "../../../components/ui/wordSwap";

// The intro promises three swaps that settle back on the first word before it can leave. That
// depends on how the tokens relate to the catalogs, so pin it here.
describe("launch motion tokens", () => {
  const {
    wordSwapIntervalMs,
    wordSwapTransitionMs,
    launchSwaps,
    launchMinMs,
    launchMaxMs,
    launchExitMs,
  } = tokens.motion;

  it.each(["en", "es"])("%s: the swaps settle back on the first word inside launchMinMs", (lng) => {
    const words = i18n.t("launch.words", { returnObjects: true, lng });
    const run = swapSequence(words.length, launchSwaps, 0);
    expect(launchSwaps).toBeGreaterThanOrEqual(3);
    expect(run[run.length - 1]).toBe(0);
    expect(new Set(run).size).toBeGreaterThanOrEqual(3); // three different words roll by
    expect(launchSwaps * wordSwapIntervalMs).toBeLessThanOrEqual(launchMinMs);
  });

  it("the transition fits inside the interval and the exit stays quick", () => {
    expect(wordSwapTransitionMs).toBeLessThan(wordSwapIntervalMs);
    expect(launchMinMs).toBeLessThan(launchMaxMs);
    expect(launchExitMs).toBeLessThanOrEqual(250);
  });
});
