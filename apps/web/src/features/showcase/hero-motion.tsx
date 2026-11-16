"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { chooseHeroMode, maxPixelRatio, readHeroEnv, STILL_QUERY } from "./hero3d/capabilities";
import { beatAt, dominantScreen, pinProgress } from "./hero3d/choreography";
import { loadTriggers } from "./hero3d/load-triggers";
import type { PhoneScene } from "./hero3d/phone-scene";

type HeroMotionProps = {
  children: ReactNode;
  className: string;
  /** Site paths of the screen captures, in HERO_SCREEN_IDS order. */
  screens: readonly string[];
};

/** Runs `run` once the page has loaded and the browser is idle; returns a cancel. */
function afterLoadAndIdle(run: () => void): () => void {
  let cancelled = false;
  let idle = 0;
  let timer = 0;
  const go = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") {
      idle = window.requestIdleCallback(run, { timeout: 2500 });
    } else {
      timer = window.setTimeout(run, 300);
    }
  };
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", go);
    if (idle) window.cancelIdleCallback(idle);
    if (timer) window.clearTimeout(timer);
  };
}

/**
 * The pinned hero's stage (#403 PR 2). The server renders all of it: this component only
 * reads how far the reader has scrolled through the hero (the section around it) and writes
 * it on the stage as attributes CSS reacts to, with no React render per scroll:
 *
 * - `data-mode`: `static`, `css` or `webgl` (hero3d/capabilities.ts);
 * - `data-beat`: which of the three headlines shows; `data-screen`: which capture the phone
 *   drawn in CSS shows;
 * - `data-gl="ready"`: the 3D phone has replaced the CSS one.
 *
 * Nothing here changes the scroll or holds input back: the browser scrolls as it always does
 * (the listeners below are passive and only notice the first intent). In `webgl` mode the 3D
 * code is downloaded once the page has loaded and the browser is idle, and three.js is
 * evaluated, with the WebGL setup, on the reader's first intent (hero3d/scene-loader.ts); both
 * wait for a pinned hero in a visible tab. Until the phone is ready, and whenever it fails, the
 * CSS phone stays.
 */
export function HeroMotion({ children, className, screens }: HeroMotionProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const screenList = screens.join("\n");

  useEffect(() => {
    const stage = stageRef.current;
    const section = stage?.parentElement;
    if (!stage || !section) return;

    const env = readHeroEnv(window);
    const mode = chooseHeroMode(env);
    stage.dataset.mode = mode;
    if (mode === "static") return;

    // Not pinned (a phone held sideways): the CSS keeps the first headline and screen.
    const still = window.matchMedia(STILL_QUERY);
    let progress = 0;
    let frame = 0;
    let scene: PhoneScene | null = null;
    let stopped = false;

    const update = () => {
      frame = 0;
      if (still.matches) {
        progress = 0;
        delete stage.dataset.beat;
        delete stage.dataset.screen;
      } else {
        const box = section.getBoundingClientRect();
        const stickTop = Number.parseFloat(getComputedStyle(stage).top) || 0;
        progress = pinProgress(box.top, box.height, stickTop, stage.offsetHeight);
        const beat = String(beatAt(progress));
        const screen = String(dominantScreen(progress));
        if (stage.dataset.beat !== beat) stage.dataset.beat = beat;
        if (stage.dataset.screen !== screen) stage.dataset.screen = screen;
      }
      scene?.setProgress(progress);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    still.addEventListener("change", schedule);

    const toCss = () => {
      stage.dataset.mode = "css";
      delete stage.dataset.gl;
      scene?.dispose();
      scene = null;
    };

    // The 3D chunk (scene-loader.ts): downloaded once the page has loaded and the browser is
    // idle, but three.js inside it is evaluated only on the reader's first intent.
    let chunk: Promise<typeof import("./hero3d/scene-loader")> | null = null;
    const download = () => (chunk ??= import("./hero3d/scene-loader"));

    const build = async () => {
      const container = stage.querySelector<HTMLElement>("[data-hero-canvas]");
      if (!container || stopped) return;
      let created: PhoneScene | null = null;
      try {
        const { phoneSceneModule } = await download();
        if (stopped) return;
        const { createPhoneScene } = phoneSceneModule(); // evaluates three.js
        // Let the browser breathe between evaluating three.js and making the GL context:
        // two shorter tasks instead of one long one.
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        if (stopped) return;
        created = await createPhoneScene({
          container,
          screens: screenList.split("\n"),
          maxPixelRatio: maxPixelRatio(env),
          onLost: toCss,
        });
        const smooth = !stopped && (await created.probe());
        if (stopped || !smooth) {
          created.dispose();
          if (!stopped) toCss();
          return;
        }
      } catch {
        created?.dispose();
        if (!stopped) toCss();
        return;
      }
      scene = created;
      scene.setProgress(progress);
      scene.reveal();
      stage.dataset.gl = "ready";
    };

    // Downloaded when the page is idle, built on the first intent, both only for a pinned hero
    // in a tab the reader sees (hero3d/load-triggers.ts). The hero opens the page, so it is
    // always within a screen of the viewport: being near it is no trigger of its own.
    const canLoad = () => !stopped && !still.matches && document.visibilityState === "visible";
    const triggers = loadTriggers({
      canLoad,
      download: () => void download().catch(() => {}),
      build: () => {
        stopListening();
        void build();
      },
    });
    const INTENT = ["scroll", "wheel", "touchstart", "pointerdown", "keydown"] as const;
    const onIntent = () => triggers.intent();
    const onChange = () => triggers.changed();
    const stopListening = () => {
      for (const type of INTENT) window.removeEventListener(type, onIntent, true);
      still.removeEventListener("change", onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
    let cancelIdle = () => {};
    if (mode === "webgl") {
      for (const type of INTENT) {
        window.addEventListener(type, onIntent, { capture: true, passive: true });
      }
      still.addEventListener("change", onChange);
      document.addEventListener("visibilitychange", onChange);
      cancelIdle = afterLoadAndIdle(() => triggers.idle());
    }

    return () => {
      stopped = true;
      cancelIdle();
      stopListening();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      still.removeEventListener("change", schedule);
      if (frame) cancelAnimationFrame(frame);
      scene?.dispose();
      scene = null;
    };
  }, [screenList]);

  return (
    <div ref={stageRef} className={className}>
      {children}
    </div>
  );
}
