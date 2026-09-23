import { appendTemplateRunEvent, failedJob, finalizeTemplateRun, getJob, getJobByUuid } from "@anycrawl/db";
import { log } from "@anycrawl/libs";
import { QueueManager } from "@anycrawl/scrape";

/** A single Store Run must finish within one minute, including queue time. */
export const SINGLE_RUN_TIMEOUT_MS = 60_000;

export async function stopSingleJob(jobId: string): Promise<void> {
    try {
        const job = await getJob(jobId);
        if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return;
        try {
            await QueueManager.getInstance().cancelJob(job.jobQueueName as any, job.jobId);
        } catch (error) {
            log.warning(`[TEMPLATE-RUN] Could not remove timed-out queue job ${job.jobId}: ${error}`);
        }
        await failedJob(job.jobId, "Single run timed out", false, { total: 1, completed: 0, failed: 1 });
    } catch (error) {
        log.warning(`[TEMPLATE-RUN] Could not stop timed-out job ${jobId}: ${error}`);
    }
}

/** Atomically expire a Run, then stop its backing job when it is still present. */
export async function expireSingleRun(run: any, jobId?: string | null): Promise<any | null> {
    const finishedAt = new Date();
    const finalized = await finalizeTemplateRun(run.uuid, "failed", {
        stopReason: "timeout",
        errorCode: "RUN_TIMEOUT",
        errorMessage: `Single run exceeded ${SINGLE_RUN_TIMEOUT_MS / 1000} seconds`,
        finishedAt,
    });
    if (!finalized) return null;

    await appendTemplateRunEvent(run.uuid, "run_failed", {
        error: "RUN_TIMEOUT",
        message: `Single run exceeded ${SINGLE_RUN_TIMEOUT_MS / 1000} seconds`,
    });

    try {
        const linkedJob = !jobId && run.legacyJobUuid ? await getJobByUuid(run.legacyJobUuid) : null;
        if (jobId || linkedJob?.jobId) await stopSingleJob(jobId ?? linkedJob.jobId);
    } catch (error) {
        log.warning(`[TEMPLATE-RUN] Could not stop timed-out job for ${run.uuid}: ${error}`);
    }
    return finalized;
}
