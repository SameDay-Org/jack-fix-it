import {
  Box3,
  Euler,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Texture,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";

import { MEDIA } from "../media";

import { CAMERA_FOV_DEGREES, cssPhoneTransform, POSE_KEYS, type PhonePose } from "./choreography";
import { createPhone, PHONE, roundedPlane } from "./phone-model";
import { cameraDistance } from "./phone-scene";

/** The meshes of the phone whose material is a plain (unlit) one: screen layers, island. */
function unlit(group: ReturnType<typeof createPhone>["group"]): Mesh[] {
  const meshes: Mesh[] = [];
  group.traverse((node) => {
    if (node instanceof Mesh && node.material instanceof MeshBasicMaterial) meshes.push(node);
  });
  return meshes;
}

describe("the 3D phone", () => {
  it("has the screen proportions of the app's captures, so a capture fills it uncut", () => {
    const { width, height } = MEDIA.home.poster;
    expect(PHONE.screen.width / PHONE.screen.height).toBeCloseTo(width / height, 6);
  });

  it("is a phone-sized slab: 1 wide, its height and depth as declared", () => {
    const phone = createPhone(null);
    const size = new Box3().setFromObject(phone.group).getSize(new Vector3());
    // The side buttons stand a little off the band.
    expect(size.x).toBeGreaterThan(PHONE.width);
    expect(size.x).toBeLessThan(PHONE.width + 0.05);
    expect(size.y).toBeCloseTo(PHONE.height, 3);
    expect(size.z).toBeGreaterThanOrEqual(PHONE.depth);
    expect(size.z).toBeLessThan(PHONE.depth + 0.03);
    phone.dispose();
  });

  it("maps a texture onto the whole screen, corner to corner", () => {
    const plane = roundedPlane(PHONE.screen.width, PHONE.screen.height, PHONE.screen.radius);
    const uv = plane.getAttribute("uv");
    const us = Array.from({ length: uv.count }, (_, i) => uv.getX(i));
    const vs = Array.from({ length: uv.count }, (_, i) => uv.getY(i));
    expect(Math.min(...us)).toBeCloseTo(0, 6);
    expect(Math.max(...us)).toBeCloseTo(1, 6);
    expect(Math.min(...vs)).toBeCloseTo(0, 6);
    expect(Math.max(...vs)).toBeCloseTo(1, 6);
    plane.dispose();
  });

  it("shows one capture, and fades the next one in over it", () => {
    const phone = createPhone(null);
    const [under, over] = unlit(phone.group);
    const home = new Texture();
    const quotes = new Texture();

    phone.setScreens(home, home, 0);
    expect((under.material as MeshBasicMaterial).map).toBe(home);
    expect(over.visible).toBe(false);

    phone.setScreens(home, quotes, 0.4);
    expect((over.material as MeshBasicMaterial).map).toBe(quotes);
    expect((over.material as MeshBasicMaterial).opacity).toBeCloseTo(0.4);
    expect(over.visible).toBe(true);
    phone.dispose();
  });

  it("keeps the screens' colours as captured (no tone mapping on them)", () => {
    const phone = createPhone(null);
    const [under, over] = unlit(phone.group);
    expect((under.material as MeshBasicMaterial).toneMapped).toBe(false);
    expect((over.material as MeshBasicMaterial).toneMapped).toBe(false);
    phone.dispose();
  });

  it("releases every geometry and material it made", () => {
    const phone = createPhone(null);
    const released = { geometries: 0, materials: 0 };
    phone.group.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      node.geometry.addEventListener("dispose", () => (released.geometries += 1));
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        material.addEventListener("dispose", () => (released.materials += 1));
      }
    });
    phone.dispose();
    // Shared ones are released once: the screen layers share a geometry, the buttons the band.
    expect(released.geometries).toBeGreaterThan(5);
    expect(released.materials).toBeGreaterThan(6);
  });
});

describe("the 3D scene's arithmetic", () => {
  it("moves the camera in as the phone fills more of the view, and back on a narrow canvas", () => {
    expect(cameraDistance(0.95, 0.8)).toBeLessThan(cameraDistance(0.74, 0.8));
    expect(cameraDistance(0.95, 0.3)).toBeGreaterThan(cameraDistance(0.95, 0.8));
  });
});

/** A canvas as tall as the hero's phone column on a laptop, wide enough to frame by height. */
const CANVAS = { width: 640, height: 800 };
/** The front's distance from the centre the phone turns around (phone-model.ts, `front`). */
const FRONT = PHONE.depth / 2;
/** The phone's corners (three.js units: y up), on its front: the plane of its screen. */
const CORNERS = [-1, 1].flatMap((sx) =>
  [-1, 1].map((sy) => [(sx * PHONE.width) / 2, (sy * PHONE.height) / 2] as const),
);

/** Where the 3D scene draws a corner: pixels from the canvas's centre, y down. */
function drawn3d(pose: PhonePose, [x, y]: readonly [number, number]): [number, number] {
  const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, CANVAS.width / CANVAS.height, 0.1, 50);
  camera.position.set(0, 0, cameraDistance(pose.fill, camera.aspect));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const turn = new Matrix4().makeRotationFromEuler(new Euler(pose.rotX, pose.rotY, pose.rotZ));
  const ndc = new Vector3(x, y, FRONT).applyMatrix4(turn).project(camera);
  return [(ndc.x * CANVAS.width) / 2, (-ndc.y * CANVAS.height) / 2];
}

/**
 * Where the browser draws the same corner of the CSS phone (a box `fill` of the canvas tall,
 * centred, its size container), read from the transform string as CSS Transforms defines its
 * functions: applied right to left around the box's centre, y down, translateZ towards the
 * reader, and perspective(d) dividing by 1 - z / d.
 */
function drawnCss(pose: PhonePose, [x, y]: readonly [number, number]): [number, number] {
  const box = pose.fill * CANVAS.height;
  const scale = box / PHONE.height;
  const steps = [...cssPhoneTransform(pose).matchAll(/(\w+)\((-?[\d.]+)(cqh|rad)\)/g)];
  expect(steps.map(([, name]) => name)).toEqual([
    "perspective",
    "rotateX",
    "rotateY",
    "rotateZ",
    "translateZ",
  ]);
  let [px, py, pz, w] = [x * scale, -y * scale, 0, 1];
  for (const [, name, value] of steps.reverse()) {
    const [c, s] = [Math.cos(Number(value)), Math.sin(Number(value))];
    if (name === "translateZ") pz += (Number(value) / 100) * box;
    if (name === "rotateZ") [px, py] = [c * px - s * py, s * px + c * py];
    if (name === "rotateY") [px, pz] = [c * px + s * pz, -s * px + c * pz];
    if (name === "rotateX") [py, pz] = [c * py - s * pz, s * py + c * pz];
    if (name === "perspective") w = 1 - pz / ((Number(value) / 100) * box);
  }
  return [px / w, py / w];
}

describe("the phone drawn in CSS", () => {
  it("is compared on the plane the 3D screen sits on (its layers a hair in front)", () => {
    const layers = unlit(createPhone(null).group).map((mesh) => mesh.position.z);
    expect(layers.length).toBeGreaterThan(0);
    for (const z of layers) {
      expect(z).toBeGreaterThan(FRONT);
      expect(z).toBeLessThan(FRONT + 0.015);
    }
  });

  it.each(POSE_KEYS.map(({ at, pose }) => [at, pose] as const))(
    "stands where the 3D camera draws the phone, corner for corner (pose at %s)",
    (_at, pose) => {
      for (const corner of CORNERS) {
        const [x3d, y3d] = drawn3d(pose, corner);
        const [xCss, yCss] = drawnCss(pose, corner);
        // Within half a pixel on an 800 px tall canvas.
        expect(Math.abs(xCss - x3d)).toBeLessThan(0.5);
        expect(Math.abs(yCss - y3d)).toBeLessThan(0.5);
      }
    },
  );

  it("is turned to the left at the start, its right edge nearer and so taller", () => {
    const [pose] = POSE_KEYS.map((key) => key.pose);
    // CORNERS runs left then right, bottom then top (y up); on screen, y grows downwards.
    const [leftBottom, leftTop, rightBottom, rightTop] = CORNERS.map((c) => drawnCss(pose, c));
    expect(rightBottom[1] - rightTop[1]).toBeGreaterThan(leftBottom[1] - leftTop[1]);
    // Narrower than the same phone facing the reader: the turn hides part of the face.
    const facing = { ...pose, rotX: 0, rotY: 0, rotZ: 0 };
    const [facingLeft, , facingRight] = CORNERS.map((c) => drawnCss(facing, c));
    expect(rightTop[0] - leftTop[0]).toBeLessThan(0.9 * (facingRight[0] - facingLeft[0]));
  });
});
