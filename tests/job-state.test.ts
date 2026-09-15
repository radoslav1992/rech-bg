import { expect, it } from "vitest";
import { mergeJobs } from "../src/job-state";
import type { Job } from "../src/lib";

const recording = { id: "recording", project_id: "project", title: "Запис", status: "running", chars: 100, duration: 0, created_at: 1 } satisfies Job;

it("replaces an optimistic running snapshot when polling reports completion", () => {
  const jobs = mergeJobs([recording, recording], [{ ...recording, status: "completed", duration: 34 }]);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].status).toBe("completed");
  expect(jobs.some(j => ["queued", "running"].includes(j.status))).toBe(false);
});

it("keeps a just-submitted video while the job list has not caught up", () => {
  const video = { ...recording, id: "video", kind: "video" as const, status: "queued" };
  const jobs = mergeJobs([video], [{ ...recording, status: "completed" }]);
  expect(jobs.filter(j => ["queued", "running"].includes(j.status))).toEqual([video]);
});
