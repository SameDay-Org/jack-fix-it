import { useEffect } from "react";

import { useSessionGeneration } from "@/api";
import { useInForeground } from "@/features/jobs/api";

import { useProJobs } from "../api";
import { isSharedStep, mayShare, sharedJobId, startSharing, stopSharing } from "./sender";

/**
 * Keeps sharing in step with the pro's jobs (#352) while the signed-in app is up; draws nothing.
 * With the app in front, it shares a job on the way (not checked in) that the pro chose to share
 * this session: the one shared already if it is still on the way, else the soonest. With no job on
 * the way, sharing ends. A list that has not loaded (a customer's, or one that failed) changes
 * nothing.
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
    const chosen = onTheWay.filter(({ id }) => mayShare(id));
    const job = chosen.find(({ id }) => id === sharedJobId()) ?? chosen[0];
    if (job) void startSharing(job.id, generation);
  }, [data, foreground, generation]);

  return null;
}
