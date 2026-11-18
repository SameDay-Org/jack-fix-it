#!/usr/bin/env node
// Builds the live map's 3D utility van (#353): a low-poly cargo van as a binary glTF, in the
// brand's colors read from src/theme/tokens.json. No dependencies and no randomness: the same
// tokens always give the same bytes.
//
//   node scripts/generate-van-model.mjs          writes assets/models/van.glb
//   node scripts/generate-van-model.mjs --check  exits 1 when the committed file is out of date
//
// The van is in meters, as long as a real one (5 m), standing on y = 0 with its center on the
// origin: +Y is up and the nose points to +Z, the front of a glTF asset.
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(root, "assets/models/van.glb");
const { colors } = JSON.parse(readFileSync(resolve(root, "src/theme/tokens.json"), "utf8"));

// The body: half its width, the ground clearance, the roof, and the side profile from the rear
// doors to the nose as [z, y] points.
const HALF_WIDTH = 1;
const FLOOR = 0.3;
const ROOF = 2.25;
const REAR = -2.5;
const ROOF_FRONT = [1.1, ROOF];
const HOOD_REAR = [1.8, 1.25];
const HOOD_FRONT = [2.4, 1.12];
const NOSE = [2.5, 0.8];
const CARGO = [[REAR, FLOOR], [REAR, ROOF], ROOF_FRONT, HOOD_REAR, [HOOD_REAR[0], FLOOR]];
const HOOD = [[HOOD_REAR[0], FLOOR], HOOD_REAR, HOOD_FRONT, NOSE, [NOSE[0], FLOOR]];
// Wheels: tires that stand a little proud of the body, drawn with this many sides.
const WHEEL = { radius: 0.38, axles: [-1.55, 1.55], inner: 0.72, outer: 1.03, sides: 10 };
// Glass, stripes and lights lie this far outside the body's faces, so they never flicker with it.
const PROUD = 0.03;
// The middle of the van: every face looks away from it.
const CENTER = [0, 1.2, 0];

const MATERIALS = [
  { name: "body", color: colors["navy-900"], roughness: 0.55 },
  { name: "accent", color: colors["green-500"], roughness: 0.6 },
  { name: "glass", color: colors["gray-50"], roughness: 0.2 },
  { name: "tire", color: colors["gray-500"], roughness: 0.9 },
  { name: "headlight", color: colors.white, roughness: 0.3 },
  { name: "taillight", color: colors.danger, roughness: 0.4 },
];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v) => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};
const mean = (points) =>
  points
    .reduce((sum, p) => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]], [0, 0, 0])
    .map((value) => value / points.length);

const meshes = new Map(
  MATERIALS.map(({ name }) => [name, { positions: [], normals: [], indices: [] }]),
);

/** One flat convex face, wound so it looks away from `inside`, moved `lift` along its normal. */
function face(material, points, inside, lift = 0) {
  let normal = unit(cross(sub(points[1], points[0]), sub(points[2], points[0])));
  let ordered = points;
  if (dot(normal, sub(mean(points), inside)) < 0) {
    normal = normal.map((value) => -value);
    ordered = [...points].reverse();
  }
  const mesh = meshes.get(material);
  const first = mesh.positions.length / 3;
  for (const point of ordered) {
    mesh.positions.push(...point.map((value, axis) => value + normal[axis] * lift));
    mesh.normals.push(...normal);
  }
  for (let index = 1; index < ordered.length - 1; index += 1) {
    mesh.indices.push(first, first + index, first + index + 1);
  }
}

/** A convex [z, y] profile pulled across x from `left` to `right`: its two ends and its sides. */
function prism(material, profile, left, right) {
  const at = (x) => profile.map(([z, y]) => [x, y, z]);
  const [a, b] = [at(left), at(right)];
  const inside = mean([...a, ...b]);
  face(material, a, inside);
  face(material, b, inside);
  profile.forEach((_, index) => {
    const next = (index + 1) % profile.length;
    face(material, [a[index], a[next], b[next], b[index]], inside);
  });
}

/** A flat panel on the body's skin, a little proud of it. */
const panel = (material, points) => face(material, points, CENTER, PROUD);
/** The point `share` of the way from one [z, y] profile point to another, at `x`. */
const along = ([z0, y0], [z1, y1], share, x) => [x, y0 + (y1 - y0) * share, z0 + (z1 - z0) * share];
/** A panel on the left and its mirror on the right. */
const bothSides = (material, points) => {
  panel(material, points);
  panel(
    material,
    points.map(([x, y, z]) => [-x, y, z]),
  );
};

prism("body", CARGO, -HALF_WIDTH, HALF_WIDTH);
prism("body", HOOD, -HALF_WIDTH, HALF_WIDTH);

for (const axle of WHEEL.axles) {
  const rim = Array.from({ length: WHEEL.sides }, (_, index) => {
    const angle = (2 * Math.PI * index) / WHEEL.sides;
    return [axle + WHEEL.radius * Math.cos(angle), WHEEL.radius * (1 + Math.sin(angle))];
  });
  prism("tire", rim, WHEEL.inner, WHEEL.outer);
  prism("tire", rim, -WHEEL.outer, -WHEEL.inner);
}

// The lime stripe along each side, and one down the roof: the accent the camera sees from above.
bothSides("accent", [
  [HALF_WIDTH, 0.85, REAR],
  [HALF_WIDTH, 0.85, HOOD_FRONT[0]],
  [HALF_WIDTH, 1.1, HOOD_FRONT[0]],
  [HALF_WIDTH, 1.1, REAR],
]);
panel("accent", [
  [-0.32, ROOF, REAR],
  [0.32, ROOF, REAR],
  [0.32, ROOF, ROOF_FRONT[0]],
  [-0.32, ROOF, ROOF_FRONT[0]],
]);

// Glass: the windshield on the slanted face, a window on each side of the cab, two in the rear.
panel("glass", [
  along(ROOF_FRONT, HOOD_REAR, 0.1, -0.86),
  along(ROOF_FRONT, HOOD_REAR, 0.1, 0.86),
  along(ROOF_FRONT, HOOD_REAR, 0.9, 0.86),
  along(ROOF_FRONT, HOOD_REAR, 0.9, -0.86),
]);
bothSides("glass", [
  [HALF_WIDTH, 1.35, 0.35],
  [HALF_WIDTH, 1.35, 1.66],
  [HALF_WIDTH, 2.08, 1.16],
  [HALF_WIDTH, 2.08, 0.35],
]);
bothSides("glass", [
  [0.1, 1.4, REAR],
  [0.8, 1.4, REAR],
  [0.8, 2.0, REAR],
  [0.1, 2.0, REAR],
]);

// Lights say which end is the front: white on the nose, red at the rear corners.
bothSides("headlight", [
  along(HOOD_FRONT, NOSE, 0.15, 0.5),
  along(HOOD_FRONT, NOSE, 0.15, 0.92),
  along(HOOD_FRONT, NOSE, 0.9, 0.92),
  along(HOOD_FRONT, NOSE, 0.9, 0.5),
]);
bothSides("taillight", [
  [0.84, 0.95, REAR],
  [0.98, 0.95, REAR],
  [0.98, 1.6, REAR],
  [0.84, 1.6, REAR],
]);

/** A token's sRGB hex as glTF's linear base color. */
function baseColor(hex) {
  const linear = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    const value = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return Math.round(value * 10_000) / 10_000;
  });
  return [...linear, 1];
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const chunks = [];
const gltf = {
  asset: { version: "2.0", generator: "jack-fix-it scripts/generate-van-model.mjs" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: "van", mesh: 0 }],
  meshes: [{ name: "van", primitives: [] }],
  materials: [],
  accessors: [],
  bufferViews: [],
  buffers: [],
};
let offset = 0;

/** Appends typed data as its own 4-byte aligned buffer view and returns its accessor's index. */
function accessor(data, type, target, bounds = {}) {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
  gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
  gltf.accessors.push({
    bufferView: gltf.bufferViews.length - 1,
    componentType: data instanceof Float32Array ? FLOAT : UNSIGNED_SHORT,
    count: type === "SCALAR" ? data.length : data.length / 3,
    type,
    ...bounds,
  });
  chunks.push(padded);
  offset += padded.length;
  return gltf.accessors.length - 1;
}

MATERIALS.forEach(({ name, color, roughness }, material) => {
  const mesh = meshes.get(name);
  const positions = new Float32Array(mesh.positions);
  const axis = (pick) =>
    [0, 1, 2].map((start) => pick(...positions.filter((_, i) => i % 3 === start)));
  gltf.materials.push({
    name,
    pbrMetallicRoughness: {
      baseColorFactor: baseColor(color),
      metallicFactor: 0,
      roughnessFactor: roughness,
    },
  });
  gltf.meshes[0].primitives.push({
    attributes: {
      POSITION: accessor(positions, "VEC3", ARRAY_BUFFER, {
        min: axis(Math.min),
        max: axis(Math.max),
      }),
      NORMAL: accessor(new Float32Array(mesh.normals), "VEC3", ARRAY_BUFFER),
    },
    indices: accessor(new Uint16Array(mesh.indices), "SCALAR", ELEMENT_ARRAY_BUFFER),
    material,
  });
});

const binary = Buffer.concat(chunks);
gltf.buffers.push({ byteLength: binary.length });
const text = Buffer.from(JSON.stringify(gltf), "utf8");
const json = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, " ")]);

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const header = Buffer.alloc(12);
header.writeUInt32LE(GLB_MAGIC, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
const chunkHeader = (length, kind) => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(length, 0);
  head.writeUInt32LE(kind, 4);
  return head;
};
const glb = Buffer.concat([
  header,
  chunkHeader(json.length, JSON_CHUNK),
  json,
  chunkHeader(binary.length, BIN_CHUNK),
  binary,
]);

if (process.argv.includes("--check")) {
  let committed = null;
  try {
    committed = readFileSync(OUTPUT);
  } catch {
    // No file yet: out of date.
  }
  if (committed === null || !committed.equals(glb)) {
    console.error("assets/models/van.glb is out of date: run node scripts/generate-van-model.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(OUTPUT, glb);
  console.log(`van.glb: ${glb.length} bytes, ${offset} of geometry`);
}
