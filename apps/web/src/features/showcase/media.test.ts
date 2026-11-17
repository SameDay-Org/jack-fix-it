import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

import { CLIP_SECONDS, MEDIA, MEDIA_IDS, MEDIA_PATH_PREFIX, type ShowcaseMedia } from "./media";

const PUBLIC_DIR = fileURLToPath(new URL("../../../public", import.meta.url));
/** A still is one screen of a phone: anything heavier than this was not prepared for the web. */
const POSTER_MAX_BYTES = 200 * 1024;
/** The target of handoffs/showcase-media-needed.md for one clip file. */
const CLIP_MAX_BYTES = 1.2 * 1024 * 1024;

function publicFile(sitePath: string): string {
  return `${PUBLIC_DIR}${sitePath}`;
}

/** The pixel size in a WebP file's header (lossy, lossless or extended). */
function webpSize(file: Buffer): { width: number; height: number } {
  if (file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("not a WebP file");
  }
  const chunk = file.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    return { width: file.readUInt16LE(26) & 0x3fff, height: file.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = file.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: file.readUIntLE(24, 3) + 1, height: file.readUIntLE(27, 3) + 1 };
  }
  throw new Error(`unknown WebP chunk ${chunk}`);
}

const entries: ShowcaseMedia[] = Object.values(MEDIA);

describe("showcase media manifest", () => {
  it("has one entry per id, under its own id", () => {
    expect(Object.keys(MEDIA)).toEqual([...MEDIA_IDS]);
    for (const id of MEDIA_IDS) expect(MEDIA[id].id).toBe(id);
  });

  it.each(entries)("$id: the poster is a WebP file of the size the manifest states", (media) => {
    const { src, width, height } = media.poster;
    expect(src.startsWith(MEDIA_PATH_PREFIX)).toBe(true);
    expect(src).toMatch(/^\/showcase\/[a-z0-9/-]+\.webp$/);

    const file = readFileSync(publicFile(src));
    // The page reserves the screen's space from these numbers: a wrong one shifts the layout.
    expect(webpSize(file)).toEqual({ width, height });
    expect(height).toBeGreaterThan(width); // a phone screen, upright
    expect(file.byteLength).toBeLessThanOrEqual(POSTER_MAX_BYTES);
  });

  it.each(entries)("$id: has a whole clip (mp4, webm, duration) or none of it", (media) => {
    const parts = [media.mp4, media.webm, media.duration];
    if (media.mp4 === null) {
      expect(parts).toEqual([null, null, null]);
      return;
    }
    expect(media.mp4).toMatch(/^\/showcase\/[a-z0-9/-]+\.mp4$/);
    expect(media.webm).toMatch(/^\/showcase\/[a-z0-9/-]+\.webm$/);
    for (const path of [media.mp4, media.webm]) {
      expect(existsSync(publicFile(path)), path).toBe(true);
      expect(statSync(publicFile(path)).size, path).toBeLessThanOrEqual(CLIP_MAX_BYTES);
    }
    expect(media.duration).toBeGreaterThanOrEqual(CLIP_SECONDS.min);
    expect(media.duration).toBeLessThanOrEqual(CLIP_SECONDS.max);
  });

  it.each(entries)("$id: a final clip is not a placeholder", (media) => {
    // The low-resolution stills are placeholders; an entry with its footage is final.
    if (media.mp4 !== null) expect(media.placeholder).toBe(false);
  });

  it.each(entries)("$id: says what the screen shows, in English and in Spanish", (media) => {
    expect(media.alt).toBe(`showcase.media.${media.id}`);
    for (const catalog of [en, es]) {
      expect(catalog.showcase.media[media.id]).toEqual(expect.stringMatching(/\S{3,}/));
    }
    expect(es.showcase.media[media.id]).not.toBe(en.showcase.media[media.id]);
  });
});
