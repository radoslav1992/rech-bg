import type { Job } from "./lib";

// Poll results replace optimistic snapshots; one job ID always means one record.
export function mergeJobs(...snapshots: Job[][]): Job[] {
  const jobs = new Map<string, Job>();
  for (const snapshot of snapshots)
    for (const job of snapshot) jobs.set(job.id, job);
  return [...jobs.values()];
}
