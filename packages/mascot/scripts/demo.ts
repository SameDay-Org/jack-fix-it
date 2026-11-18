/**
 * The gallery's motion section, in the browser (served by preview.ts with its types stripped):
 * mounts Jack with the plain DOM version (src/dom.ts) in each `[data-demo]` stage and shows each
 * one's motion state (still, paused or running).
 */
import { mountMascot, type MountedMascot } from "../src/dom.ts";
import { isReadyPose, REDUCED_MOTION_QUERY } from "../src/index.ts";

let forcedReduced = false;
const mounted: MountedMascot[] = [];

for (const stage of document.querySelectorAll<HTMLElement>("[data-demo]")) {
  const demo = stage.dataset.demo ?? "";
  const pose = stage.dataset.pose ?? "";
  if (!isReadyPose(pose)) continue;
  const status = document.querySelector(`[data-status-for="${demo}"]`);
  const mascot = mountMascot(stage, {
    pose,
    size: 256,
    title: `Jack, ${pose}`,
    forceReduced: () => forcedReduced,
    onMotion: (state) => {
      if (status) status.textContent = state;
      stage.dataset.motion = state;
    },
  });
  mounted.push(mascot);
  if (demo !== "transition") continue;
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-to]");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const to = button.dataset.to ?? "";
      if (!isReadyPose(to)) return;
      mascot.setPose(to);
      stage.dataset.pose = to;
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
    });
  }
}

const reduce = document.querySelector<HTMLInputElement>("#reduce");
reduce?.addEventListener("change", () => {
  forcedReduced = reduce.checked;
  for (const mascot of mounted) mascot.refresh();
});

const system = document.querySelector("#reduce-system");
if (system && matchMedia(REDUCED_MOTION_QUERY).matches) {
  system.textContent = "Your system asks for reduced motion: nothing moves.";
}
