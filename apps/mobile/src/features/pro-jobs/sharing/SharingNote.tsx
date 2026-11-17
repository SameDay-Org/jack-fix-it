import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { useGuardedPush } from "@/features/quotes/navigation";

import { hasEnded, sharedJobId, subscribeSharing } from "./sender";

/**
 * On the way and not shared (#352): one calm line that the customer does not see the pro coming,
 * and "Share location", which opens the explanation (`/jobs/[id]/share-location`). That screen is
 * the only way to share: nothing is asked or recorded here, whatever the permission already allows
 * (a grant made for check-in included). The job itself goes on either way. A job the API refused
 * (cancelled or checked in elsewhere) has no line: nothing could share it, and the screen catches
 * up on its next read.
 */
export function SharingNote({ jobId, name }: { jobId: string; name: string }) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  const quiet = useSyncExternalStore(
    subscribeSharing,
    useCallback(() => sharedJobId() === jobId || hasEnded(jobId), [jobId]),
  );
  if (quiet) return null;

  return (
    <RetryNotice
      message={t("proJobs.sharing.note.message", { name })}
      action={t("proJobs.sharing.note.share")}
      onRetry={() => push({ pathname: "/jobs/[id]/share-location", params: { id: jobId } })}
      testID="pro-job-sharing-note"
    />
  );
}
