import {
  ACESFilmicToneMapping,
  CanvasTexture,
  ClampToEdgeWrapping,
  DirectionalLight,
  LinearMipmapLinearFilter,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  WebGLRenderer,
  type Texture,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { FRONT_POSE, mixPose, poseAt, screenAt, smoothstep, type PhonePose } from "./choreography";
import { createPhone, PHONE } from "./phone-model";

/**
 * The hero's 3D phone (#403 PR 2). This module and three.js are loaded only after the page
 * (hero-motion.tsx imports it dynamically), never with it.
 *
 * It draws on demand: a frame when the scroll moves the story, while the drawn pose catches
 * up with the scroll (a short smoothing; the page's scrolling itself is never touched), and
 * during the reveal. Nothing is drawn while the canvas is off-screen (IntersectionObserver)
 * or the tab is hidden. The canvas takes no pointer or touch input: a finger on it scrolls
 * the page.
 */

export type PhoneSceneOptions = {
  container: HTMLElement;
  /** Site paths of the screen captures, in HERO_SCREEN_IDS order. */
  screens: readonly string[];
  maxPixelRatio: number;
  /** Called once if the GPU drops the context: the hero goes back to the CSS phone. */
  onLost: () => void;
};

export type PhoneScene = {
  setProgress(p: number): void;
  /** Draws frames for a moment and says whether they come fast enough for smooth motion. */
  probe(): Promise<boolean>;
  /** Turns the phone from facing the reader (as the CSS phone does) to the scroll's pose. */
  reveal(): void;
  dispose(): void;
};

/** Frame-time probe: the median gap between frames must stay under `maxMedianMs`. */
export const PROBE = { frames: 24, maxMedianMs: 45, timeoutMs: 4000 } as const;

const FOV = 28;
/** Per second: how fast the drawn pose catches up with the scroll's. */
const SMOOTHING = 12;
const REVEAL_MS = 900;
/** The widest the turned phone gets, as a share of its width, and the room kept at the sides. */
const TURNED_WIDTH = 1.15;
const SIDE_ROOM = 0.92;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * How far the camera stands for the phone to take `fill` of the canvas's height, moved back
 * when the canvas is too narrow for the turned phone.
 */
export function cameraDistance(fill: number, aspect: number, fovDegrees = FOV): number {
  const span = 2 * Math.tan((fovDegrees * Math.PI) / 360);
  const byHeight = PHONE.height / (fill * span);
  const byWidth = (PHONE.width * TURNED_WIDTH) / (SIDE_ROOM * span * aspect);
  return Math.max(byHeight, byWidth);
}

function glareTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (context) {
    const streak = context.createLinearGradient(0, 0, 256, 512);
    streak.addColorStop(0, "rgba(255,255,255,0)");
    streak.addColorStop(0.4, "rgba(255,255,255,0)");
    streak.addColorStop(0.5, "rgba(255,255,255,0.5)");
    streak.addColorStop(0.6, "rgba(255,255,255,0)");
    streak.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = streak;
    context.fillRect(0, 0, 256, 512);
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export async function createPhoneScene(options: PhoneSceneOptions): Promise<PhoneScene> {
  const { container, screens, maxPixelRatio, onLost } = options;

  // Throws where only a slow software renderer exists: the caller keeps the CSS phone.
  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: true,
    failIfMajorPerformanceCaveat: true,
  });
  const canvas = renderer.domElement;
  const loader = new TextureLoader();
  let textures: Texture[] = [];
  try {
    textures = await Promise.all(
      screens.map(async (src) => {
        const texture = await loader.loadAsync(src);
        texture.colorSpace = SRGBColorSpace;
        texture.minFilter = LinearMipmapLinearFilter;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        return texture;
      }),
    );
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }

  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "block size-full";

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  scene.environment = environment;
  const key = new DirectionalLight(0xffffff, 1.2);
  key.position.set(-2, 3, 4);
  scene.add(key);

  const glare = glareTexture();
  const phone = createPhone(glare);
  scene.add(phone.group);
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 50);

  let target = 0;
  let drawn = 0;
  let revealStart: number | null = null;
  let visible = true;
  let disposed = false;
  let frame = 0;
  let last = 0;

  function resize() {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function draw(now: number) {
    let pose: PhonePose = poseAt(drawn);
    if (revealStart !== null) {
      pose = mixPose(FRONT_POSE, pose, smoothstep((now - revealStart) / REVEAL_MS));
    } else {
      pose = FRONT_POSE;
    }
    phone.group.rotation.set(pose.rotX, pose.rotY, pose.rotZ);
    camera.position.set(0, 0, cameraDistance(pose.fill, camera.aspect));
    camera.lookAt(0, 0, 0);
    const mix = screenAt(drawn);
    phone.setScreens(textures[mix.index], textures[mix.next], mix.blend);
    phone.setTurn(pose.rotY);
    renderer.render(scene, camera);
  }

  function tick(now: number) {
    frame = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    drawn += (target - drawn) * (1 - Math.exp(-dt * SMOOTHING));
    if (Math.abs(target - drawn) < 1e-4) drawn = target;
    draw(now);
    const revealing = revealStart !== null && now - revealStart < REVEAL_MS;
    if (visible && !disposed && (drawn !== target || revealing)) {
      frame = requestAnimationFrame(tick);
    } else {
      last = 0;
    }
  }

  function wake() {
    if (!frame && visible && !disposed) frame = requestAnimationFrame(tick);
  }

  const resizeObserver = new ResizeObserver(() => {
    resize();
    if (visible) draw(performance.now());
  });
  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    container.dataset.state = visible ? "active" : "paused";
    if (visible) wake();
  });

  const lost = (event: Event) => {
    event.preventDefault();
    if (!disposed) onLost();
  };
  canvas.addEventListener("webglcontextlost", lost);

  container.append(canvas);
  resize();
  renderer.compile(scene, camera);
  resizeObserver.observe(container);
  visibility.observe(container);

  return {
    setProgress(p) {
      target = p;
      wake();
    },
    probe() {
      return new Promise<boolean>((resolve) => {
        const gaps: number[] = [];
        let previous = 0;
        let handle = 0;
        const timer = window.setTimeout(() => {
          cancelAnimationFrame(handle);
          resolve(false);
        }, PROBE.timeoutMs);
        const step = (now: number) => {
          if (disposed) {
            window.clearTimeout(timer);
            resolve(false);
            return;
          }
          draw(now);
          if (previous) gaps.push(now - previous);
          previous = now;
          if (gaps.length >= PROBE.frames) {
            window.clearTimeout(timer);
            resolve(median(gaps) <= PROBE.maxMedianMs);
            return;
          }
          handle = requestAnimationFrame(step);
        };
        handle = requestAnimationFrame(step);
      });
    },
    reveal() {
      drawn = target;
      revealStart = performance.now();
      wake();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibility.disconnect();
      canvas.removeEventListener("webglcontextlost", lost);
      phone.dispose();
      textures.forEach((texture) => texture.dispose());
      glare.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      delete container.dataset.state;
    },
  };
}
