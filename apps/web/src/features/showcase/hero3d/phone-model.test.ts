import { Box3, Mesh, MeshBasicMaterial, Texture, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { MEDIA } from "../media";

import { createPhone, PHONE, roundedPlane } from "./phone-model";
import { cameraDistance, median, PROBE } from "./phone-scene";

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
  it("takes the median frame gap, so one slow frame (shader compile) does not decide", () => {
    expect(median([16, 17, 300, 16, 18])).toBe(17);
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(PROBE.maxMedianMs).toBeLessThan(50);
  });

  it("moves the camera in as the phone fills more of the view, and back on a narrow canvas", () => {
    expect(cameraDistance(0.95, 0.8)).toBeLessThan(cameraDistance(0.74, 0.8));
    expect(cameraDistance(0.95, 0.3)).toBeGreaterThan(cameraDistance(0.95, 0.8));
  });
});
