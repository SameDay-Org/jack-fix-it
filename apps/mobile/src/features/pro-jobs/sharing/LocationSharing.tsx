import { useEffect } from "react";

import { useSessionGeneration } from "@/api";
import { useInForeground } from "@/features/jobs/api";

import { useProJobs } from "../api";
import { isSharedStep, sharedJobId, startSharing, stopSharing } from "./sender";

/**
 * Keeps sharing in step with the pro's jobs (#352) while the signed-in app is up; draws nothing.
 * With a job on the way (not checked in) and the app in front, it shares that job: the one shared
 * already if it is still on the way, else the soonest. With none, sharing ends. A list that has
 * not loaded (a customer's, or one that failed) changes nothing.
 */
export function LocationSharing() {
  const generation = useSessionGeneration();
  const foreground = useInForeground();
  const { data } = useProJobs({ refetchOnReturn: false });

  useEffect(() => {
    if (data === undefined) return;
    const onTheWay = data.filter(isSharedStep);
    if (onTheWay.length === 0) {
      void stopSharing();
      return;
    }
    if (!foreground) return;
    const job = onTheWay.find(({ id }) => id === sharedJobId()) ?? onTheWay[0];
    void startSharing(job.id, generation);
  }, [data, foreground, generation]);

  return null;
}
