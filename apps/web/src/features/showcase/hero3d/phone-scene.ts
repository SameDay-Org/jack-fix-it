import {
  CanvasTexture,
  ClampToEdgeWrapping,
  ImageBitmapLoader,
  LinearMipmapLinearFilter,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  WebGLRenderer,
} from "three";

import { CAMERA_FOV_DEGREES, revealPose, screenAt } from "./choreography";
import { browserProbeHost, probeFrames } from "./frame-probe";
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
 *
 * It is kept cheap to prepare on a phone's CPU: unlit matcap materials (no lights, no
 * environment map), shaders compiled without blocking where the GPU allows it
 * (compileAsync), and screen captures decoded off the main thread (createImageBitmap).
 * Before it is handed over, everything the scroll will need is on the GPU (shaders and every
 * screen capture, one upload per frame), so no screen change stalls a frame later. If the
 * GPU drops the context before that, creating or probing the scene fails; after it, `onLost`
 * tells the hero to go back to the CSS phone.
 */

export type PhoneSceneOptions = {
  container: HTMLElement;
  /** Site paths of the screen captures, in HERO_SCREEN_IDS order. */
  screens: readonly string[];
  maxPixelRatio: number;
  /** Called once if the GPU drops the context after the reveal. */
  onLost: () => void;
};

export type PhoneScene = {
  setProgress(p: number): void;
  /** Draws frames for a moment and says whether they come fast enough (frame-probe.ts). */
  probe(): Promise<boolean>;
  /** Turns the phone from the CSS phone's pose (the story's start) to the scroll's pose. */
  reveal(): void;
  dispose(): void;
};

const FOV = CAMERA_FOV_DEGREES;
/** Per second: how fast the drawn pose catches up with the scroll's. */
const SMOOTHING = 12;
const REVEAL_MS = 900;
/** The widest the turned phone gets, as a share of its width, and the room kept at the sides. */
const TURNED_WIDTH = 1.15;
const SIDE_ROOM = 0.92;

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

/** A 2D canvas, or null where the browser cannot make one. */
function canvas2d(
  width: number,
  height: number,
): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return [canvas, canvas.getContext("2d")];
}

/**
 * A matcap: a sphere lit from the upper left, darker towards its rim, with a faint ring of
 * light near the rim that the band's bevel catches as the phone turns.
 */
function matcapTexture(stops: readonly [number, string][], key: string): CanvasTexture {
  const size = 256;
  const half = size / 2;
  const [canvas, context] = canvas2d(size, size);
  if (context) {
    const body = context.createRadialGradient(
      size * 0.4,
      size * 0.35,
      size * 0.04,
      half,
      half,
      half,
    );
    for (const [at, colour] of stops) body.addColorStop(at, colour);
    context.fillStyle = body;
    context.fillRect(0, 0, size, size);
    const light = context.createRadialGradient(
      size * 0.32,
      size * 0.27,
      0,
      size * 0.32,
      size * 0.27,
      size * 0.32,
    );
    light.addColorStop(0, key);
    light.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = light;
    context.fillRect(0, 0, size, size);
    const rim = context.createRadialGradient(half, half, size * 0.36, half, half, half);
    rim.addColorStop(0, "rgba(255,255,255,0)");
    rim.addColorStop(0.78, "rgba(255,255,255,0.3)");
    rim.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = rim;
    context.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A screen capture as a texture, decoded off the main thread where the browser can. */
async function screenTexture(src: string, bitmaps: ImageBitmap[]): Promise<Texture> {
  if (typeof createImageBitmap !== "function") return new TextureLoader().loadAsync(src);
  const loader = new ImageBitmapLoader();
  loader.setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" });
  const bitmap = await loader.loadAsync(src);
  bitmaps.push(bitmap);
  const texture = new Texture(bitmap);
  texture.flipY = false; // flipped when decoded
  texture.needsUpdate = true;
  return texture;
}

function glareTexture(): CanvasTexture {
  const [canvas, context] = canvas2d(256, 512);
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

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

export async function createPhoneScene(options: PhoneSceneOptions): Promise<PhoneScene> {
  const { container, screens, maxPixelRatio, onLost } = options;

  // The one WebGL test: no WebGL 2, or only a slow software one, and this throws quietly
  // (three.js is handed the context, so it logs nothing); the caller keeps the CSS phone.
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    depth: true,
    stencil: false,
    failIfMajorPerformanceCaveat: true,
  });
  if (!context) throw new Error("No fast WebGL 2 here: the CSS phone stays.");
  const renderer = new WebGLRenderer({ canvas, context });
  let contextLost = false;
  let handedOver = false;
  let disposed = false;
  const lost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
    if (handedOver && !disposed) onLost();
  };
  canvas.addEventListener("webglcontextlost", lost);
  const alive = () => !disposed && !contextLost && !renderer.getContext().isContextLost();

  // Filled in as they are made, so that a failure half-way releases what exists.
  const textures: Texture[] = [];
  const bitmaps: ImageBitmap[] = [];
  const releaseImages = () => {
    textures.forEach((texture) => texture.dispose());
    bitmaps.forEach((bitmap) => bitmap.close());
  };
  let release = () => {
    releaseImages();
    canvas.removeEventListener("webglcontextlost", lost);
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };

  try {
    const loaded = await Promise.all(
      screens.map(async (src) => {
        const texture = await screenTexture(src, bitmaps);
        texture.colorSpace = SRGBColorSpace;
        texture.minFilter = LinearMipmapLinearFilter;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        return texture;
      }),
    );
    textures.push(...loaded);
    if (!alive()) throw new Error("The WebGL context was lost while the screens loaded.");
  } catch (error) {
    release();
    throw error;
  }

  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "block size-full";

  const scene = new Scene();
  const looks = {
    glare: glareTexture(),
    metal: matcapTexture(
      [
        [0, "#f2f4f6"],
        [0.45, "#b8bcc1"],
        [0.8, "#7b8086"],
        [1, "#555a61"],
      ],
      "rgba(255,255,255,0.9)",
    ),
    glass: matcapTexture(
      [
        [0, "#66717b"],
        [0.5, "#1e252c"],
        [1, "#05080b"],
      ],
      "rgba(255,255,255,0.45)",
    ),
  };
  textures.push(looks.glare, looks.metal, looks.glass);
  const phone = createPhone(looks);
  scene.add(phone.group);
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 50);

  let target = 0;
  let drawn = 0;
  let revealStart: number | null = null;
  let visible = true;
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
    // Before the reveal: the CSS phone's pose (the story's start), so the hand-over shows no jump.
    const pose = revealPose(drawn, revealStart === null ? 0 : (now - revealStart) / REVEAL_MS);
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
    if (visible && !disposed) draw(performance.now());
  });
  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    container.dataset.state = visible ? "active" : "paused";
    if (visible) wake();
  });

  release = () => {
    if (frame) cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    visibility.disconnect();
    canvas.removeEventListener("webglcontextlost", lost);
    phone.dispose();
    releaseImages();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    delete container.dataset.state;
  };

  try {
    container.append(canvas);
    resize();
    await renderer.compileAsync(scene, camera);
    if (!alive()) throw new Error("The WebGL context was lost while the shaders compiled.");
    // Every capture on the GPU now, one per frame, while the CSS phone still shows: no upload
    // stalls a frame when the scroll first brings a screen in.
    for (const texture of textures) {
      renderer.initTexture(texture);
      await nextFrame();
      if (!alive()) throw new Error("The WebGL context was lost while the screens uploaded.");
    }
  } catch (error) {
    disposed = true;
    release();
    throw error;
  }
  resizeObserver.observe(container);
  visibility.observe(container);

  return {
    setProgress(p) {
      target = p;
      wake();
    },
    probe() {
      return probeFrames(browserProbeHost(window), draw, alive);
    },
    reveal() {
      handedOver = true;
      drawn = target;
      revealStart = performance.now();
      wake();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
    },
  };
}
