import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isCurrentGeneration, sessionGeneration } from "@/api";
import { showToast } from "@/components/ui";
import { announce } from "@/components/ui/focus";
import { useMediaUpload, type MediaItem, type MediaUpload } from "@/features/media";

import { attachPhoto, useSingleFlight } from "./api";
import { proJobsConfig } from "./config";
import { reportStepFailure } from "./failure";
import type { JobPhoto, JobPhotoKind, ProJob } from "./phase";

/** Uploads the API turned away on the last save, by why: each one is added again. */
export type TurnedAway = { expired: number; refused: number };

const NONE_TURNED_AWAY: TurnedAway = { expired: 0, refused: 0 };
const NO_PHOTOS: readonly JobPhoto[] = [];

export type JobPhotos = {
  kind: JobPhotoKind;
  /** The photos on the job, oldest first, as the API lists them. */
  saved: readonly JobPhoto[];
  /** The photos picked here and not on the job yet: their uploads, progress and failures. */
  upload: MediaUpload;
  /** Most photos of the kind the job holds. */
  max: number;
  /** Saved photos known to have failed their safe copy: they do not count toward `max`. */
  failed: number;
  /** How many more can be picked: what the cap leaves once failed copies are set aside. */
  room: number;
  /** The picked photo whose attachment is being sent: it can no longer be removed. */
  attaching: string | null;
  /** Removes a picked photo, unless its attachment is already on its way. */
  remove: (id: string) => void;
  /** Uploaded and waiting for Save. */
  ready: number;
  /** A photo still being prepared or uploaded: Save waits for it. */
  uploading: boolean;
  saving: boolean;
  /** Picked here and not on the job yet, failed ones aside: Job's done waits for them. */
  pending: boolean;
  /** Attaches every uploaded photo, in the order picked, one at a time. */
  save: () => void;
  turnedAway: TurnedAway;
  /** Clears the turned-away notice (adding a photo again does too). */
  dismissTurnedAway: () => void;
};

const isUploading = (item: MediaItem) =>
  item.status === "compressing" || item.status === "uploading";

/** The API keeps this many rows per photo slot, failed copies included (#298). */
const ROWS_PER_SLOT = 2;

/**
 * How many more photos fit, as the API counts (#298): failed copies are left out of the live cap,
 * and every row, failed ones included, stays within `ROWS_PER_SLOT` times it.
 */
export function photoRoom(saved: number, failed: number, max: number): number {
  return Math.max(0, Math.min(max - (saved - failed), ROWS_PER_SLOT * max - saved));
}

/**
 * The before or after photos of one job: those on it, and those picked here (`useMediaUpload`,
 * purpose `job_photo`) until Save attaches them. Held by the job screen, so the list outlives a
 * step change (Start job moves the sections) and Job's done can wait for it. A picked photo can be
 * removed until its attachment is sent, even while Save runs on the ones before it; once sent it
 * stays (there is no delete, so a removal could not undo it). Every save belongs to the session
 * it started in: a later answer for another one changes nothing and says nothing. Until the job
 * has loaded there is nothing to save.
 *
 * `failed` is how many saved photos are known to have failed their privacy-safe copy. The pro's
 * view has no per-photo status (#343): Job's done answering `after_photos_required` while photos
 * are on the job is the one sign, and then all of them failed. Those are set aside from the cap,
 * as the API does, so a replacement can be picked.
 */
export function useJobPhotos(job: ProJob | undefined, kind: JobPhotoKind, failed = 0): JobPhotos {
  const { t } = useTranslation();
  const client = useQueryClient();
  const saved = job?.photos[kind] ?? NO_PHOTOS;
  const max = proJobsConfig.photoMaxPerKind;
  const known = Math.min(failed, saved.length);
  const room = photoRoom(saved.length, known, max);
  const upload = useMediaUpload({ purpose: "job_photo", max: room });
  const { busy: saving, run, mounted } = useSingleFlight();
  const [turnedAway, setTurnedAway] = useState<TurnedAway>(NONE_TURNED_AWAY);
  const { items, remove: drop } = upload;
  // The one being sent, as state for the row and as a ref for a tap that beats the re-render.
  const [attaching, setAttaching] = useState<string | null>(null);
  const sending = useRef<string | null>(null);
  const remove = useCallback(
    (id: string) => {
      if (sending.current !== id) drop(id);
    },
    [drop],
  );
  const ready = items.filter((item) => item.status === "done" && item.key !== null);
  const uploading = items.some(isUploading);

  // The list as it stands now, for a save under way: a photo removed meanwhile is not attached.
  const live = useRef(items);
  useEffect(() => {
    live.current = items;
  }, [items]);

  const save = () =>
    void run(async () => {
      if (!job) return;
      const generation = sessionGeneration();
      const current = () => mounted.current && isCurrentGeneration(generation);
      const away: TurnedAway = { expired: 0, refused: 0 };
      let attached = 0;
      setTurnedAway(NONE_TURNED_AWAY);
      for (const item of ready) {
        if (item.key === null || !live.current.some((entry) => entry.id === item.id)) continue;
        sending.current = item.id;
        setAttaching(item.id);
        let outcome: Awaited<ReturnType<typeof attachPhoto>>;
        try {
          outcome = await attachPhoto(client, job.id, kind, item.key, generation);
        } finally {
          sending.current = null;
          if (mounted.current) setAttaching(null);
        }
        if (!current()) return;
        if (outcome.kind === "attached") {
          attached += 1;
          drop(item.id);
          continue;
        }
        if (outcome.kind === "expired" || outcome.kind === "refused") {
          // The upload can't go on the job: it leaves the list, and the notice asks for it again.
          away[outcome.kind] += 1;
          drop(item.id);
          continue;
        }
        if (outcome.kind === "full") {
          showToast({ message: t(`proJobs.photos.${kind}.full`, { max }), tone: "danger" });
        } else {
          reportStepFailure(t, client, job.id, generation, outcome.failure);
        }
        break;
      }
      if (away.expired + away.refused > 0) setTurnedAway(away);
      if (attached > 0) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => undefined,
        );
        announce(t(`proJobs.photos.${kind}.savedAnnounce`, { count: attached }));
      }
    });

  const dismissTurnedAway = useCallback(() => setTurnedAway(NONE_TURNED_AWAY), []);

  return {
    kind,
    saved,
    upload,
    max,
    failed: known,
    room,
    attaching,
    remove,
    ready: ready.length,
    uploading,
    saving,
    pending: saving || uploading || ready.length > 0,
    save,
    turnedAway,
    dismissTurnedAway,
  };
}
