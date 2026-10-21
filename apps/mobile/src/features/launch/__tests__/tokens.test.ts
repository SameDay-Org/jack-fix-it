import i18n from "@/i18n";
import { tokens } from "@/theme";

import { swapSteps } from "../../../components/ui/wordSwap";

// The intro promises to settle back on the first word before it can leave, and to show at least
// three swaps. Both depend on how the tokens relate to the catalogs, so pin that here.
describe("launch motion tokens", () => {
  const { wordSwapIntervalMs, wordSwapTransitionMs, launchMinMs, launchMaxMs, launchExitMs } =
    tokens.motion;

  it.each(["en", "es"])("%s: one full word cycle fits inside launchMinMs", (lng) => {
    const words = i18n.t("launch.words", { returnObjects: true, lng });
    const cycleMs = swapSteps(words.length, 0) * wordSwapIntervalMs;
    expect(words.length).toBeGreaterThanOrEqual(4); // at least three swaps are visible
    expect(cycleMs).toBeLessThanOrEqual(launchMinMs);
  });

  it("the transition fits inside the interval and the exit stays quick", () => {
    expect(wordSwapTransitionMs).toBeLessThan(wordSwapIntervalMs);
    expect(launchMinMs).toBeLessThan(launchMaxMs);
    expect(launchExitMs).toBeLessThanOrEqual(250);
  });
});
