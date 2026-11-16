import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { useSessionGeneration } from "@/api";
import { RetryNotice } from "@/features/opportunities/RetryNotice";

import { ensureLocationOn, useLocationAccess } from "../location";
import { shareJob, sharedJobId, subscribeSharing } from "./sender";

/**
 * On the way and not shared (#352): one calm line that the customer does not see the pro coming,
 * and the one way to change it. "Share location" records the pro's choice, asks for the "while
 * using" permission (no prompt once given) and, on Android, offers to switch the location on;
 * refused for good, "Open Settings" (sharing starts once the app is back in front with it). The
 * job itself goes on either way.
 */
export function SharingNote({ jobId, name }: { jobId: string; name: string }) {
  const { t } = useTranslation();
  const generation = useSessionGeneration();
  const { access, ask, openSettings } = useLocationAccess();
  const shared = useSyncExternalStore(
    subscribeSharing,
    useCallback(() => sharedJobId() === jobId, [jobId]),
  );
  if (shared || access === "unknown") return null;

  const blocked = access === "blocked";
  const turnOn = () => {
    if (blocked) {
      void shareJob(jobId, generation);
      openSettings();
      return;
    }
    void (async () => {
      if (!(await ask())) return;
      // Switched off and left off (declined, or iOS, which has no such dialog): nothing to share.
      await ensureLocationOn().catch(() => undefined);
      await shareJob(jobId, generation);
    })();
  };

  return (
    <RetryNotice
      message={t("proJobs.sharing.note.message", { name })}
      action={t(blocked ? "proJobs.sharing.note.settings" : "proJobs.sharing.note.share")}
      onRetry={turnOn}
      testID="pro-job-sharing-note"
    />
  );
}
