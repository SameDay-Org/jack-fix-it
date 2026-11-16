import {
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Shape,
  ShapeGeometry,
  type BufferGeometry,
  type Material,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/**
 * The 3D phone of the hero, built from code: no model file is downloaded, and nothing of it
 * comes from a third party or from Apple (MODEL.md). A modern phone in the brand's light:
 * a rounded titanium band with a soft bevel, a dark glass front, the screen, the camera
 * island, the side buttons and a faint reflection that moves as the phone turns.
 *
 * Units: the body is 1 wide. The screen keeps the 1:2 of the app's captures (media.ts), so a
 * capture fills it without being cut or stretched. The side buttons sit where the phone
 * drawn in CSS has them (phone-frame.tsx), so the two phones match when one replaces the
 * other.
 */
export const PHONE = {
  width: 1,
  height: 1.9,
  depth: 0.1,
  /** The corner radius of the body, seen from the front. */
  radius: 0.17,
  /** The rounded edge of the band. */
  bevel: 0.03,
  screen: { width: 0.9, height: 1.8, radius: 0.125 },
  /** The camera island, a pill below the screen's top edge. */
  island: { width: 0.27, height: 0.075, fromTop: 0.035 },
} as const;

/** Side buttons: `top` and `height` as shares of the body's height, as in phone-frame.tsx. */
const BUTTONS = [
  { side: -1, top: 0.15, height: 0.035 },
  { side: -1, top: 0.22, height: 0.065 },
  { side: -1, top: 0.3, height: 0.065 },
  { side: 1, top: 0.25, height: 0.1 },
] as const;

/** Front layers, each a hair in front of the last (scene units). */
const LAYER = 0.002;

/** A rectangle with round corners, centred on the origin. */
export function roundedRect(width: number, height: number, radius: number): Shape {
  const x = width / 2 - radius;
  const y = height / 2 - radius;
  const shape = new Shape();
  shape.absarc(x, -y, radius, -Math.PI / 2, 0, false);
  shape.absarc(x, y, radius, 0, Math.PI / 2, false);
  shape.absarc(-x, y, radius, Math.PI / 2, Math.PI, false);
  shape.absarc(-x, -y, radius, Math.PI, Math.PI * 1.5, false);
  shape.closePath();
  return shape;
}

/** A flat rounded rectangle whose texture coordinates span it exactly (0 to 1 both ways). */
export function roundedPlane(width: number, height: number, radius: number): ShapeGeometry {
  const geometry = new ShapeGeometry(roundedRect(width, height, radius), 24);
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < position.count; i += 1) {
    uv.setXY(i, position.getX(i) / width + 0.5, position.getY(i) / height + 0.5);
  }
  uv.needsUpdate = true;
  return geometry;
}

export type Phone = {
  group: Group;
  /** Shows `under`, with `over` faded in on top of it by `blend` (0 to 1). */
  setScreens(under: Texture, over: Texture, blend: number): void;
  /** Moves the reflection with the phone's turn (radians around the vertical axis). */
  setTurn(rotY: number): void;
  dispose(): void;
};

/** `glare`: a texture of a soft light streak, or null for none (tests have no canvas). */
export function createPhone(glare: Texture | null): Phone {
  const { width, height, depth, radius, bevel, screen, island } = PHONE;
  const front = depth / 2;
  const group = new Group();

  const titanium = new MeshStandardMaterial({ color: 0x8f9398, metalness: 1, roughness: 0.34 });
  const backGlass = new MeshStandardMaterial({ color: 0x14202c, metalness: 0.1, roughness: 0.3 });
  const frontGlass = new MeshStandardMaterial({ color: 0x020407, metalness: 0, roughness: 0.08 });

  // The body: a rounded slab whose edge is the band. Extrusion caps are the glass faces
  // (material 0), the walls and their bevel are the band (material 1).
  const inner = roundedRect(width - 2 * bevel, height - 2 * bevel, radius - bevel);
  const slab = depth - 2 * bevel;
  const bodyGeometry = new ExtrudeGeometry(inner, {
    depth: slab,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 8,
    curveSegments: 40,
  });
  bodyGeometry.translate(0, 0, -slab / 2);
  group.add(new Mesh(bodyGeometry, [backGlass, titanium]));

  // The front glass: dark, glossy, to the start of the band's curve.
  const glass = new Mesh(
    roundedPlane(width - 2 * bevel + 0.012, height - 2 * bevel + 0.012, radius - bevel + 0.006),
    frontGlass,
  );
  glass.position.z = front + LAYER;
  group.add(glass);

  // The screen: two layers, so one capture can fade in over another.
  const screenGeometry = roundedPlane(screen.width, screen.height, screen.radius);
  const under = new MeshBasicMaterial({ toneMapped: false });
  const over = new MeshBasicMaterial({
    toneMapped: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const underMesh = new Mesh(screenGeometry, under);
  underMesh.position.z = front + 2 * LAYER;
  const overMesh = new Mesh(screenGeometry, over);
  overMesh.position.z = front + 3 * LAYER;
  overMesh.visible = false;
  group.add(underMesh, overMesh);

  // A light streak across the glass that slides as the phone turns.
  const sheen = new MeshBasicMaterial({
    map: glare,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
  });
  const sheenMesh = new Mesh(screenGeometry, sheen);
  sheenMesh.position.z = front + 4 * LAYER;
  sheenMesh.visible = glare !== null;
  group.add(sheenMesh);

  // The camera island.
  const islandMesh = new Mesh(
    roundedPlane(island.width, island.height, island.height / 2),
    new MeshBasicMaterial({ color: 0x000000 }),
  );
  islandMesh.position.set(
    0,
    screen.height / 2 - island.fromTop - island.height / 2,
    front + 5 * LAYER,
  );
  group.add(islandMesh);

  for (const button of BUTTONS) {
    const length = button.height * height;
    const mesh = new Mesh(new RoundedBoxGeometry(0.024, length, 0.045, 2, 0.01), titanium);
    mesh.position.set(
      button.side * (width / 2 + 0.004),
      height / 2 - button.top * height - length / 2,
      0,
    );
    group.add(mesh);
  }

  return {
    group,
    setScreens(below, above, blend) {
      if (under.map !== below) {
        under.map = below;
        under.needsUpdate = true;
      }
      if (over.map !== above) {
        over.map = above;
        over.needsUpdate = true;
      }
      over.opacity = blend;
      overMesh.visible = blend > 0 && above !== below;
    },
    setTurn(rotY) {
      if (!glare) return;
      glare.offset.x = -rotY * 0.9;
      sheen.opacity = 0.05 + 0.25 * Math.min(1, Math.abs(rotY) * 2);
    },
    dispose() {
      const geometries = new Set<BufferGeometry>();
      const materials = new Set<Material>();
      group.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        geometries.add(node.geometry as BufferGeometry);
        const material = node.material as Material | Material[];
        for (const each of Array.isArray(material) ? material : [material]) materials.add(each);
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
    },
  };
}
