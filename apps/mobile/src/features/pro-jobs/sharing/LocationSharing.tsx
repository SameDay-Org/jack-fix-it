import { useEffect } from "react";

import { useSessionGeneration } from "@/api";
import { useInForeground } from "@/features/jobs/api";

import { useProJobs } from "../api";
import { isSharedStep, mayShare, sharedJobId, startSharing, stopSharing } from "./sender";

/**
 * Keeps sharing in step with the pro's jobs (#352) while the signed-in app is up; draws nothing.
 * With the app in front, it shares a job on the way (not checked in) that the pro chose to share
 * this session: the one shared already if it is still on the way, else the soonest. With no such
 * job, sharing ends; in the background, so does sharing for a job that is not the one to share
 * (the next one starts back in front). A list that has not loaded (a customer's, or one that
 * failed) changes nothing.
 */
export function LocationSharing() {
  const generation = useSessionGeneration();
  const foreground = useInForeground();
  const { data } = useProJobs({ refetchOnReturn: false });

  useEffect(() => {
    if (data === undefined) return;
    const chosen = data.filter((job) => isSharedStep(job) && mayShare(job.id));
    const shared = sharedJobId();
    const job = chosen.find(({ id }) => id === shared) ?? chosen[0];
    if (job === undefined) {
      void stopSharing();
      return;
    }
    if (foreground) void startSharing(job.id, generation);
    else if (shared !== null && shared !== job.id) void stopSharing();
  }, [data, foreground, generation]);

  return null;
}
