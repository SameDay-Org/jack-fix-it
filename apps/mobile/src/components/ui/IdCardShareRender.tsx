import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { Directory, File, Paths } from "expo-file-system";
import { Image, PixelRatio, View } from "react-native";
import ViewShot, { type CaptureOptions, type ViewShotRef } from "react-native-view-shot";

import { IdCard, type IdCardProps } from "./IdCard";

export type IdCardShareCapture = {
  /** The PNG, a file in the app's private cache (`ID_CARD_SHARE_DIR`), for the share sheet. */
  uri: string;
  /** Its pixel size: at least 3x the design width. */
  width: number;
  height: number;
  /**
   * Deletes the PNG. The capture belongs to its caller: call this once the share sheet is done
   * with it, and whenever the capture goes unused (cancelled, failed, superseded, too late).
   * Calling it again does nothing.
   */
  discard: () => void;
};

export type IdCardShareHandle = {
  /** Renders the card to a PNG, once its photo (if any) has loaded. */
  capture: () => Promise<IdCardShareCapture>;
};

export type IdCardShareRenderProps = Pick<
  IdCardProps,
  "variant" | "name" | "city" | "state" | "photoUri" | "publicCode"
> & {
  ref?: Ref<IdCardShareHandle>;
  /**
   * How long a capture waits for the photo to load (or fail) before it gives up, in milliseconds.
   * Pass the API's request timeout (`apiConfig.timeoutMs`): a remote photo comes over the same
   * network.
   */
  photoTimeoutMs: number;
  testID?: string;
};

/** The shared image's design width in dp; the PNG is this times the ratio below, or more. */
export const ID_CARD_SHARE_BASE_WIDTH = 320;
/** The least pixel ratio of the PNG: crisp when another app shows it full width. */
export const ID_CARD_SHARE_MIN_RATIO = 3;
/** Clears the card from the screen's left edge whatever its parent's inset. */
const OFFSCREEN_GAP = 64;

/**
 * The PNG comes back as base64 and never as a view-shot temporary file: on Android view-shot puts
 * its files in the external cache when that has more room, and before Android 10 other apps with
 * storage access can read it (#293). The card holds a name, a portrait and a place, so the app
 * writes the PNG itself, into its private cache.
 */
const CAPTURE: CaptureOptions = { format: "png", quality: 1, result: "base64" };
/** The folder in the app's private cache (`Paths.cache`) that holds the shared PNGs. */
export const ID_CARD_SHARE_DIR = "id-card-share";
const NOT_MOUNTED = "IdCardShareRender is not mounted";
const PHOTO_TIMED_OUT = "IdCardShareRender: the photo did not load in time";

type Waiter = { resolve: () => void; reject: (error: Error) => void };
/** One photo load: a new URI, or the same one put back after a removal, is a new load. */
type PhotoLoad = { uri: string | undefined; id: number };

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

/** Writes the base64 PNG into the app's private cache and returns the file. */
async function writePrivatePng(base64: string): Promise<File> {
  const dir = new Directory(Paths.cache, ID_CARD_SHARE_DIR);
  dir.create({ intermediates: true, idempotent: true });
  sequence += 1;
  const file = new File(dir, `card-${Date.now()}-${sequence}.png`);
  try {
    await file.write(base64, { encoding: "base64" });
  } catch (error) {
    deleteQuietly(file);
    throw error;
  }
  return file;
}

/**
 * The width to lay the card out at, in dp, so that the native capture comes out at
 * `ID_CARD_SHARE_MIN_RATIO` pixels per design dp on a 1x or 2x screen, and at the screen's own
 * density above that. `react-native-view-shot` renders at the device density and only resizes
 * (#251), so the extra pixels must come from the layout, never from scaling the bitmap up.
 */
export function idCardShareLayoutWidth(pixelRatio: number): number {
  return (ID_CARD_SHARE_BASE_WIDTH * Math.max(ID_CARD_SHARE_MIN_RATIO, pixelRatio)) / pixelRatio;
}

/**
 * The `shareable` card laid out off screen (left of the window, inert and hidden from assistive
 * technology) at the width the pixel density needs, with `capture()` on its ref. Mount it next to
 * the on-screen card and call `capture()` when the person taps Share.
 */
export function IdCardShareRender({
  ref,
  variant,
  name,
  city,
  state,
  photoUri,
  publicCode,
  photoTimeoutMs,
  testID,
}: IdCardShareRenderProps) {
  const width = idCardShareLayoutWidth(PixelRatio.get());
  const shot = useRef<ViewShotRef>(null);
  // Readiness belongs to one load, never to a URI: a photo that changes, or is taken away and put
  // back, starts a new load (the card remounts its Image per URI), and only that load's own end
  // (success or failure) makes the card ready. A late end from an earlier load is ignored.
  const [load, setLoad] = useState<PhotoLoad>({ uri: photoUri, id: 0 });
  if (load.uri !== photoUri) setLoad({ uri: photoUri, id: load.id + 1 });
  const activeLoad = useRef(load.id);
  const readyLoad = useRef<number | undefined>(undefined);
  const waiting = useRef<Waiter[]>([]);
  const mounted = useRef(true);

  const loadId = load.id;
  // Before the commit hands the card this load's callback, so no event can reach it early.
  useLayoutEffect(() => {
    activeLoad.current = loadId;
  }, [loadId]);

  const onPhotoLoadEnd = useCallback(() => {
    if (activeLoad.current !== loadId) return;
    readyLoad.current = loadId;
    for (const waiter of waiting.current.splice(0)) waiter.resolve();
  }, [loadId]);

  // A capture waits for the current photo's load, however often it changes meanwhile. Without a
  // photo there is nothing to wait for, so a photo taken away mid-wait lets the capture go on; an
  // unmount fails it instead of leaving the caller hanging, and so does a photo that never ends.
  useEffect(() => {
    if (photoUri) return;
    for (const waiter of waiting.current.splice(0)) waiter.resolve();
  }, [photoUri]);
  useEffect(() => {
    mounted.current = true;
    const pending = waiting.current;
    return () => {
      mounted.current = false;
      for (const waiter of pending.splice(0)) waiter.reject(new Error(NOT_MOUNTED));
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      capture: async () => {
        if (photoUri && readyLoad.current !== activeLoad.current) {
          await new Promise<void>((resolve, reject) => {
            const waiter: Waiter = {
              resolve: () => {
                clearTimeout(timer);
                resolve();
              },
              reject: (error) => {
                clearTimeout(timer);
                reject(error);
              },
            };
            const timer = setTimeout(() => {
              const at = waiting.current.indexOf(waiter);
              if (at >= 0) waiting.current.splice(at, 1);
              reject(new Error(PHOTO_TIMED_OUT));
            }, photoTimeoutMs);
            waiting.current.push(waiter);
          });
        }
        const target = shot.current;
        if (!target) throw new Error(NOT_MOUNTED);
        const base64 = await target.capture();
        // A capture that ends after the unmount writes nothing: no one is left to share or delete it.
        if (!mounted.current) throw new Error(NOT_MOUNTED);
        const file = await writePrivatePng(base64);
        const discard = () => deleteQuietly(file);
        try {
          const size = await Image.getSize(file.uri);
          if (!mounted.current) throw new Error(NOT_MOUNTED);
          return { uri: file.uri, width: size.width, height: size.height, discard };
        } catch (error) {
          discard();
          throw error;
        }
      },
    }),
    [photoUri, photoTimeoutMs],
  );

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
      style={{ position: "absolute", top: 0, left: -(width + OFFSCREEN_GAP), width }}
    >
      <ViewShot ref={shot} options={CAPTURE}>
        <IdCard
          shareable
          variant={variant}
          width={width}
          name={name}
          city={city}
          state={state}
          photoUri={photoUri}
          publicCode={publicCode}
          onPhotoLoadEnd={onPhotoLoadEnd}
          testID={testID ? `${testID}-card` : undefined}
        />
      </ViewShot>
    </View>
  );
}
