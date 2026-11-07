import type { CameraView } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import {
  ApiError,
  isCurrentGeneration,
  sessionGeneration,
  uploadMedia,
  UploadRejectedError,
  useSession,
} from "@/api";
import { announce } from "@/components/ui/focus";
import { useUpdateMe } from "@/features/account/api";
import { prepareMedia, type PreparedMedia } from "@/features/media/compress";
import { useCameraAccess } from "@/features/media/useCameraAccess";

import { failureKey } from "./useSignUpSteps";

/**
 * What the selfie step shows:
 * - `checking`: the camera permission is being read;
 * - `ask`: the system may still ask for the camera;
 * - `blocked`: only the device settings can turn the camera on;
 * - `camera`: the live front-camera preview;
 * - `unavailable`: the camera was allowed but would not start;
 * - `review`: a photo to use, new or the one the account already holds.
 */
export type PhotoMode = "checking" | "ask" | "blocked" | "camera" | "unavailable" | "review";

/** The step's one action, as the flow's button shows it. */
export type PhotoAction = { label: string; run: () => void; disabled: boolean };

export type PhotoStep = {
  mode: PhotoMode;
  /** The photo the frame and the card show: a new one, else the account's own. */
  photoUri: string | undefined;
  /** The live preview, for the capture. */
  camera: RefObject<CameraView | null>;
  /** The preview to mount now; one mount per preview (its `id` is the view's key). */
  preview: CameraPreview;
  /**
   * The step left the screen, or another screen covered it: its preview is released, and the next
   * visit waits for a new one to be ready (or tries a camera that failed again).
   */
  onCameraStop: () => void;
  /** The share of the photo the storage has taken, 0 to 1, while it is saved; else `null`. */
  progress: number | null;
  /** What went wrong, in the app's language. */
  failure: string | null;
  /** The photo is being saved: uploaded, then set on the account. */
  submitting: boolean;
  /** The camera or the photo library is handing a photo over. */
  capturing: boolean;
  /** The photo library is offered beside a camera that is not on. */
  offersLibrary: boolean;
  action: PhotoAction;
  pickFromLibrary: () => void;
  /** Sets the photo aside, so the camera opens again. */
  retake: () => void;
};

/** One photo's way to the account: the compressed file, then its upload key, kept for a retry. */
// `generation`: the session the photo was uploaded for; its key is never reused for another.
type Upload = { source: string; generation: number; prepared?: PreparedMedia; key?: string };

type CameraState = "starting" | "ready" | "failed";

/**
 * One mounted preview and its own reports. A preview that was released (the step left, the photo
 * was set aside, it failed to start) can still report late; its reports name an older `id` and
 * change nothing.
 */
export type CameraPreview = { id: number; onReady: () => void; onError: () => void };

const isRefusal = (error: unknown): boolean =>
  error instanceof UploadRejectedError || (error instanceof ApiError && error.status === 422);

/**
 * Step 3 (#294): the selfie. The front camera's preview, or the photo library when the camera is
 * off or would not start; the photo shows on the card at once. "Use photo" compresses it as the
 * request media are, uploads it (`profile_photo`) and sets it with PATCH /v1/auth/me; `onSaved`
 * moves the flow on only after that. A retry after a failure starts from the step that failed: a
 * finished upload is not sent again. A photo the API refuses is set aside, and the camera opens
 * for another. A photo the account already holds goes on without a request.
 */
export function usePhotoStep(onSaved: () => void): PhotoStep {
  const { t } = useTranslation();
  const { user } = useSession();
  const { mutateAsync: updateMe } = useUpdateMe();
  const { permission, requestPermission, openSettings } = useCameraAccess();
  const camera = useRef<CameraView>(null);
  const [shot, setShot] = useState<string | null>(null);
  // Retake sets the account's own photo aside as well: the camera opens instead of it.
  const [savedSetAside, setSavedSetAside] = useState(false);
  // The current preview's id, and what that preview has reported.
  const [preview, setPreview] = useState<{ id: number; state: CameraState }>({
    id: 0,
    state: "starting",
  });
  const cameraState = preview.state;
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const upload = useRef<Upload | null>(null);
  const saving = useRef<AbortController | null>(null);
  // A ref, so two taps in the same turn cannot both open the camera's shutter or the library.
  const handing = useRef(false);
  // The hand-over in flight, by turn. A shutter's turn ends with its preview (`onCameraStop`):
  // what that capture hands over late changes nothing, and the next preview can take a photo.
  const turn = useRef(0);
  const shutterOpen = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      saving.current?.abort();
    };
  }, []);

  // Every user the API returns carries a fresh signed URL for the same photo (the phone step's
  // answer too): the first one is kept, or the card would reload the photo it already shows.
  const [firstSavedUri] = useState(user?.photo?.url);
  const savedUri = savedSetAside || !user?.photo ? undefined : (firstSavedUri ?? user.photo.url);
  const photoUri = shot ?? savedUri;
  const mode: PhotoMode = photoUri
    ? "review"
    : permission === null
      ? "checking"
      : permission.granted
        ? cameraState === "failed"
          ? "unavailable"
          : "camera"
        : permission.canAskAgain
          ? "ask"
          : "blocked";
  // Camera access went away while the step is on screen (the setting was turned off): the
  // preview is gone, and the one mounted once access is back is a new one. Adjusted during the
  // render that sees the change, so no frame shows the old preview's state.
  const cameraOff = mode === "checking" || mode === "ask" || mode === "blocked";
  const [wasCameraOff, setWasCameraOff] = useState(cameraOff);
  if (cameraOff !== wasCameraOff) {
    setWasCameraOff(cameraOff);
    if (cameraOff) setPreview((current) => ({ id: current.id + 1, state: "starting" }));
  }

  const fail = useCallback((message: string) => {
    setFailure(message);
    announce(message);
  }, []);

  const choose = useCallback((uri: string) => {
    setShot(uri);
    setSaveFailed(false);
    setFailure(null);
  }, []);

  /** Runs one hand-over (the shutter or the library) at a time; its failure shows on the step. */
  const handOver = useCallback(
    async (take: () => Promise<string | null>, shutter = false) => {
      if (handing.current) return;
      handing.current = true;
      shutterOpen.current = shutter;
      const mine = ++turn.current;
      setCapturing(true);
      setFailure(null);
      try {
        const uri = await take();
        if (uri && mounted.current && mine === turn.current) choose(uri);
      } catch {
        if (mounted.current && mine === turn.current) fail(t("signUp.errors.photoPick"));
      } finally {
        if (mine === turn.current) {
          handing.current = false;
          shutterOpen.current = false;
          if (mounted.current) setCapturing(false);
        }
      }
    },
    [choose, fail, t],
  );

  const capture = useCallback(
    () =>
      void handOver(async () => {
        const view = camera.current;
        if (!view) return null;
        const picture = await view.takePictureAsync({ exif: false });
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        return picture.uri;
      }, true),
    [handOver],
  );

  const pickFromLibrary = useCallback(
    () =>
      void handOver(async () => {
        // The system photo picker runs outside the app: it needs no library permission.
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          exif: false,
        });
        return result.canceled ? null : (result.assets[0]?.uri ?? null);
      }),
    [handOver],
  );

  // A preview's report counts only while it is the current one. A preview that failed is unmounted
  // and retired at once: its id moves on, so a ready it had already queued changes nothing, and
  // the camera stays off (the library takes over) until the step leaves, another screen covers
  // this one, or access comes back.
  const report = useCallback(
    (id: number, state: CameraState) =>
      setPreview((current) =>
        current.id !== id ? current : state === "failed" ? { id: id + 1, state } : { id, state },
      ),
    [],
  );
  const previewId = preview.id;
  const currentPreview = useMemo<CameraPreview>(
    () => ({
      id: previewId,
      onReady: () => report(previewId, "ready"),
      onError: () => report(previewId, "failed"),
    }),
    [previewId, report],
  );
  // The next preview is a new one: it has to report ready itself. A capture the released preview
  // had in flight is dropped (its view is gone; the native call may never answer).
  const onCameraStop = useCallback(() => {
    setPreview((current) => ({ id: current.id + 1, state: "starting" }));
    if (shutterOpen.current) {
      turn.current += 1;
      handing.current = false;
      shutterOpen.current = false;
      setCapturing(false);
    }
  }, []);

  const retake = useCallback(() => {
    if (saving.current) return;
    setShot(null);
    setSavedSetAside(true);
    onCameraStop();
    setSaveFailed(false);
    setFailure(null);
  }, [onCameraStop]);

  const save = useCallback(async () => {
    if (saving.current) return;
    if (!shot) {
      onSaved(); // the account's own photo, kept as it is
      return;
    }
    const controller = new AbortController();
    saving.current = controller;
    // The whole save (the upload's URL and PUT, the PATCH, the step done) belongs to the session
    // this tap started in: after a sign-out or another sign-in nothing more is sent (Vault B1).
    const generation = sessionGeneration();
    setSubmitting(true);
    setSaveFailed(false);
    setFailure(null);
    try {
      const current: Upload =
        upload.current?.source === shot && upload.current.generation === generation
          ? upload.current
          : { source: shot, generation };
      upload.current = current;
      if (!current.key) {
        setProgress(0);
        current.prepared ??= await prepareMedia({ uri: shot, kind: "image" });
        const { key } = await uploadMedia({
          purpose: "profile_photo",
          file: current.prepared,
          signal: controller.signal,
          generation,
          onProgress: (fraction) => {
            if (!controller.signal.aborted) setProgress(fraction);
          },
        });
        current.key = key;
      }
      setProgress(1);
      await updateMe({ body: { photo_key: current.key }, generation });
      if (!controller.signal.aborted && isCurrentGeneration(generation)) onSaved();
    } catch (error) {
      if (controller.signal.aborted) return; // the screen left: nothing to show
      if (!isCurrentGeneration(generation)) return; // another session's now: not its news
      if (isRefusal(error)) {
        // The same file would be refused again: set it aside and open the camera for another.
        upload.current = null;
        setShot(null);
        setSavedSetAside(true);
        onCameraStop();
        fail(t("signUp.errors.photoRejected"));
      } else {
        setSaveFailed(true);
        fail(t(failureKey(error, "signUp.errors.photoSave")));
      }
    } finally {
      if (saving.current === controller) saving.current = null;
      if (mounted.current) {
        setSubmitting(false);
        setProgress(null);
      }
    }
  }, [fail, onCameraStop, onSaved, shot, t, updateMe]);

  const action = ((): PhotoAction => {
    switch (mode) {
      case "review":
        return {
          label: t(saveFailed ? "signUp.photo.retry" : "signUp.photo.use"),
          run: () => void save(),
          disabled: false,
        };
      case "camera":
        return {
          label: t("signUp.photo.take"),
          run: capture,
          disabled: cameraState !== "ready",
        };
      case "ask":
        return {
          label: t("signUp.photo.allow"),
          run: () => void requestPermission().catch(() => undefined),
          disabled: false,
        };
      case "blocked":
        return {
          label: t("signUp.photo.openSettings"),
          run: () => void openSettings().catch(() => undefined),
          disabled: false,
        };
      case "unavailable":
        return { label: t("signUp.photo.library"), run: pickFromLibrary, disabled: false };
      case "checking":
        return { label: t("signUp.photo.take"), run: () => undefined, disabled: true };
    }
  })();

  return {
    mode,
    photoUri,
    camera,
    preview: currentPreview,
    onCameraStop,
    progress,
    failure,
    submitting,
    capturing,
    offersLibrary: mode === "ask" || mode === "blocked",
    action,
    pickFromLibrary,
    retake,
  };
}
