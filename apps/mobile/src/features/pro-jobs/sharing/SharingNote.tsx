import { useTranslation } from "react-i18next";

import { useSessionGeneration } from "@/api";
import { RetryNotice } from "@/features/opportunities/RetryNotice";

import { useLocationAccess } from "../location";
import { startSharing } from "./sender";

/**
 * On the way without the location permission (#352): one calm line that the customer does not see
 * the pro coming, and the one way to change it. Never asked: the system's prompt, then sharing.
 * Refused for good: the device settings (sharing starts once the app is back in front with it).
 * The job itself goes on either way.
 */
export function SharingNote({ jobId, name }: { jobId: string; name: string }) {
  const { t } = useTranslation();
  const generation = useSessionGeneration();
  const { access, ask, openSettings } = useLocationAccess();
  if (access !== "askable" && access !== "blocked") return null;

  const turnOn =
    access === "askable"
      ? () => void ask().then((granted) => (granted ? startSharing(jobId, generation) : undefined))
      : openSettings;

  return (
    <RetryNotice
      message={t("proJobs.sharing.note.message", { name })}
      action={t(
        access === "askable" ? "proJobs.sharing.note.share" : "proJobs.sharing.note.settings",
      )}
      onRetry={turnOn}
      testID="pro-job-sharing-note"
    />
  );
}
