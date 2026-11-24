import { Directory, File, Paths } from "expo-file-system";
import { Image } from "react-native";
import type { CaptureOptions, ViewShotRef } from "react-native-view-shot";

/**
 * Turning an off-screen view into a PNG to share (#293, #62): the parts every share render uses.
 *
 * The PNG comes back as base64 and never as a view-shot temporary file: on Android view-shot puts
 * its files in the external cache when that has more room, and before Android 10 other apps with
 * storage access can read it (#293). What is shared can hold a name, a portrait, a place or money,
 * so the app writes the PNG itself, into its private cache.
 */

export type ShareCapture = {
  /** The PNG, a file in the app's private cache, for the share sheet. */
  uri: string;
  /** Its pixel size. */
  width: number;
  height: number;
  /**
   * Deletes the PNG. The capture belongs to its caller: call this once the share sheet is done
   * with it, and whenever the capture goes unused (cancelled, failed, superseded, too late).
   * Calling it again does nothing.
   */
  discard: () => void;
};

export type ShareHandle = {
  /** Renders the view to a PNG in the app's private cache. */
  capture: () => Promise<ShareCapture>;
};

export const PNG_CAPTURE: CaptureOptions = { format: "png", quality: 1, result: "base64" };

/** The least pixel ratio of a shared PNG: crisp when another app shows it full width. */
export const SHARE_MIN_RATIO = 3;

/** Clears an off-screen render from the screen's left edge whatever its parent's inset. */
export const OFFSCREEN_GAP = 64;

export const NOT_MOUNTED = "The share render is not mounted";

/**
 * The width to lay a view out at, in dp, so that the native capture comes out at
 * `SHARE_MIN_RATIO` pixels per design dp on a 1x or 2x screen, and at the screen's own density
 * above that. `react-native-view-shot` renders at the device density and only resizes (#251), so
 * the extra pixels must come from the layout, never from scaling the bitmap up.
 */
export function shareLayoutWidth(baseWidth: number, pixelRatio: number): number {
  return (baseWidth * Math.max(SHARE_MIN_RATIO, pixelRatio)) / pixelRatio;
}

/** Names each PNG apart, so one capture's discard never deletes another's file. */
let sequence = 0;

/** Deletes a PNG that may already be gone; a failed delete leaves it to the OS cache eviction. */
function deleteQuietly(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {
    // Nothing to tell the person: the file sits in the app's private cache either way.
  }
}

/** Writes the base64 PNG into the folder `dirName` of the app's private cache. */
async function writePrivatePng(base64: string, dirName: string, prefix: string): Promise<File> {
  const dir = new Directory(Paths.cache, dirName);
  dir.create({ intermediates: true, idempotent: true });
  sequence += 1;
  const file = new File(dir, `${prefix}-${Date.now()}-${sequence}.png`);
  try {
    await file.write(base64, { encoding: "base64" });
  } catch (error) {
    deleteQuietly(file);
    throw error;
  }
  return file;
}

/**
 * Captures `shot` into a private PNG (in `dirName`, named from `prefix`). A capture that ends
 * after the render went away writes nothing, or deletes what it wrote: no one is left to share or
 * delete it.
 */
export async function capturePrivatePng(
  shot: ViewShotRef | null,
  dirName: string,
  prefix: string,
  stillMounted: () => boolean,
): Promise<ShareCapture> {
  if (!shot) throw new Error(NOT_MOUNTED);
  const base64 = await shot.capture();
  if (!stillMounted()) throw new Error(NOT_MOUNTED);
  const file = await writePrivatePng(base64, dirName, prefix);
  const discard = () => deleteQuietly(file);
  try {
    const size = await Image.getSize(file.uri);
    if (!stillMounted()) throw new Error(NOT_MOUNTED);
    return { uri: file.uri, width: size.width, height: size.height, discard };
  } catch (error) {
    discard();
    throw error;
  }
}
