import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { isCurrentGeneration, sessionGeneration } from "@/api";
import { showToast } from "@/components/ui";
import { announce } from "@/components/ui/focus";
import { useMediaUpload, type MediaUpload } from "@/features/media";

import { attachPhoto, useSingleFlight } from "./api";
import { proJobsConfig } from "./config";
import { reportStepFailure } from "./failure";
import type { JobPhoto, JobPhotoKind, ProJob } from "./phase";

/** Uploads the API turned away on the last save, by why: each one is added again. */
export type TurnedAway = { expired: number; refused: number };

const NONE_TURNED_AWAY: TurnedAway = { expired: 0, refused: 0 };

export type JobPhotos = {
  /** The photos on the job, oldest first, as the API lists them. */
  saved: readonly JobPhoto[];
  /** The photos picked here and not on the job yet: their uploads, progress and failures. */
  upload: MediaUpload;
  /** Most photos of the kind the job holds. */
  max: number;
  /** Uploaded and waiting for Save. */
  ready: number;
  /** A photo still being prepared or uploaded: Save waits for it. */
  uploading: boolean;
  saving: boolean;
  /** Attaches every uploaded photo, in the order picked, one at a time. */
  save: () => void;
  turnedAway: TurnedAway;
  /** Clears the turned-away notice (adding a photo again does too). */
  dismissTurnedAway: () => void;
};

/**
 * The before or after photos of one job: those on it, and those picked here (`useMediaUpload`,
 * purpose `job_photo`) until Save attaches them. A picked photo can be removed until it is saved;
 * once on the job it stays (there is no delete). Every save belongs to the session it started in:
 * a later answer for another one changes nothing and says nothing.
 */
export function useJobPhotos(job: ProJob, kind: JobPhotoKind): JobPhotos {
  const { t } = useTranslation();
  const client = useQueryClient();
  const saved = job.photos[kind];
  const max = proJobsConfig.photoMaxPerKind;
  const upload = useMediaUpload({ purpose: "job_photo", max: Math.max(0, max - saved.length) });
  const { busy: saving, run, mounted } = useSingleFlight();
  const [turnedAway, setTurnedAway] = useState<TurnedAway>(NONE_TURNED_AWAY);
  const { items, remove } = upload;
  const ready = items.filter((item) => item.status === "done" && item.key !== null);
  const uploading = items.some(
    (item) => item.status === "compressing" || item.status === "uploading",
  );

  const save = () =>
    void run(async () => {
      const generation = sessionGeneration();
      const live = () => mounted.current && isCurrentGeneration(generation);
      const away: TurnedAway = { expired: 0, refused: 0 };
      let attached = 0;
      setTurnedAway(NONE_TURNED_AWAY);
      for (const item of ready) {
        if (item.key === null) continue;
        const outcome = await attachPhoto(client, job.id, kind, item.key, generation);
        if (!live()) return;
        if (outcome.kind === "attached") {
          attached += 1;
          remove(item.id);
          continue;
        }
        if (outcome.kind === "expired" || outcome.kind === "refused") {
          // The upload can't go on the job: it leaves the list, and the notice asks for it again.
          away[outcome.kind] += 1;
          remove(item.id);
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
    saved,
    upload,
    max,
    ready: ready.length,
    uploading,
    saving,
    save,
    turnedAway,
    dismissTurnedAway,
  };
}
