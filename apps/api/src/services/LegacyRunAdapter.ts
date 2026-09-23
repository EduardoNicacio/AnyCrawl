import { Response } from "express";
import { RequestWithAuth, log } from "@anycrawl/libs";
import {
    getDB,
    schemas,
    eq,
    appendTemplateRunEvent,
    updateTemplateRunStatus,
    finalizeTemplateRun,
    getJob,
} from "@anycrawl/db";
import { ScrapeController } from "../controllers/v1/ScrapeController.js";
import { SearchController } from "../controllers/v1/SearchController.js";
import { CrawlController } from "../controllers/v1/CrawlController.js";
import { expireSingleRun, SINGLE_RUN_TIMEOUT_MS, stopSingleJob } from "./SingleRunTimeout.js";

/**
 * Legacy Run Adapter (design doc §7.1).
 *
 * Wraps the existing scrape / search / crawl execution chain so a Template Run
 * reproduces a `template_id` call byte-for-byte, then records the outcome on the
 * unified `template_runs` lifecycle. Per §7.1 the adapter ONLY wraps the legacy
 * chain — it never re-implements variable merging, domain validation, handlers
 * or **billing logic**. It drives the existing controllers' public entry points
 * with a response-capturing shim, so:
 *
 *   - the controller runs the identical merge → schema parse → renderUrlTemplate →
 *     job create/enqueue/wait → Dataset write path as `POST /v1/template/{ref}/execute`;
 *   - the controller sets `req.jobId` + `req.creditsUsed` + `req.billingChargeDetails`
 *     via the shared `CreditCalculator` (+ template `pricing.perCall`), so the
 *     app-level `DeductCreditsMiddleware` charges the run identically to `/execute`;
 *   - the captured JSON (`{ success, data, dataset }`) is mapped onto the run's
 *     terminal state, statistics, dataset pointers and `/events` feed.
 *
 * The controllers and their tests stay byte-unchanged; no controller private
 * method is imported. The adapter sets `req.resolvedTemplateType` so the deduct
 * middleware selects the right billing mode (crawl = delta, scrape/search = target).
 */

/** Minimal `res` shim capturing `status()/json()` without emitting a response. */
class CapturingResponse {
    public statusCode = 0;
    public body: any = undefined;
    status(code: number): this {
        this.statusCode = code;
        return this;
    }
    json(payload: any): this {
        this.body = payload;
        return this;
    }
    /** Some Express handlers call res.send() for non-JSON; capture it defensively. */
    send(payload: any): this {
        this.body = payload;
        return this;
    }
}

export interface ExecuteSingleRunParams {
    /** The persisted `template_runs` row (queued) to drive to a terminal state. */
    run: any;
    /** Resolved template (TemplateConfig) — supplies templateId + type. */
    template: any;
    /**
     * The delegated controller request body: exactly the fields a `template_id`
     * call accepts (`template_id`, `url`|`query`, `variables`, `output`). The
     * controller performs the merge + validation itself, so this is the raw
     * request, never a pre-merged config (avoiding a double-merge).
     */
    delegatedBody: Record<string, unknown>;
    /** The live Express request (carries auth + accumulates billing fields). */
    req: RequestWithAuth;
}

export interface ExecuteSingleRunResult {
    ok: boolean;
    httpStatus: number;
    /** Producer result (`data` splice) or null. */
    result: unknown;
    /** Legacy job id created by the producer (also mirrored to `req.jobId`). */
    jobId: string | null;
    /** The `dataset` splice `{ dataset_id, dataset_run_id, status }` when written. */
    datasetOutcome: any | null;
    /** Raw producer error body when `ok` is false. */
    errorBody?: any;
}

export interface StartCrawlRunResult {
    ok: boolean;
    httpStatus: number;
    jobId: string | null;
    datasetId: string | null;
    body: any;
}

export class LegacyRunAdapter {
    private readonly scrapeController = new ScrapeController();
    private readonly searchController = new SearchController();
    private readonly crawlController = new CrawlController();

    /**
     * Run a single-mode scrape/search template SYNCHRONOUSLY (Apify run-sync
     * semantics) and finalize the run as a terminal record. Returns the producer
     * result, legacy job id, and the dataset outcome for the response envelope.
     */
    public executeSingleRun = async (
        params: ExecuteSingleRunParams
    ): Promise<ExecuteSingleRunResult> => {
        const { run, template, delegatedBody, req } = params;
        const type: "scrape" | "search" = template.templateType === "search" ? "search" : "scrape";
        const startedAt = new Date();

        // Prepare the request exactly like the /execute dispatcher, then move the
        // run to `running` before invoking the legacy controller.
        req.body = delegatedBody;
        req.resolvedTemplateType = type;
        req.templateRunDeadlineAt = Date.now() + SINGLE_RUN_TIMEOUT_MS;
        await appendTemplateRunEvent(run.uuid, "run_started", { mode: "single", template_type: type });
        await updateTemplateRunStatus(run.uuid, { status: "running", startedAt });

        req.onTemplateRunJobCreated = async (jobId) => {
            const job = await getJob(jobId);
            if (!job) throw new Error(`Backing job ${jobId} was not persisted`);
            await updateTemplateRunStatus(run.uuid, {
                legacyJobUuid: job.uuid,
                statistics: { legacy_job_id: jobId },
            });
            if (Date.now() >= req.templateRunDeadlineAt!) await stopSingleJob(jobId);
        };

        const cap = new CapturingResponse();
        const controller = type === "search" ? this.searchController : this.scrapeController;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const finished = await Promise.race([
            controller.handle(req, cap as unknown as Response).then(() => true),
            new Promise<false>((resolve) => {
                timeoutId = setTimeout(() => resolve(false), SINGLE_RUN_TIMEOUT_MS);
            }),
        ]).finally(() => clearTimeout(timeoutId));
        if (!finished) {
            req.creditsUsed = 0;
            req.billingChargeDetails = undefined;
            await expireSingleRun(run, req.jobId);
            return {
                ok: false,
                httpStatus: 504,
                result: null,
                jobId: req.jobId ?? null,
                datasetOutcome: null,
                errorBody: { success: false, error: "RUN_TIMEOUT", message: "Single run exceeded 60 seconds" },
            };
        }

        const httpStatus = cap.statusCode || 200;
        const body = cap.body ?? {};
        const ok = httpStatus >= 200 && httpStatus < 300 && body?.success === true;
        const jobId = req.jobId ?? null;
        const datasetOutcome = body?.dataset ?? null;
        const datasetRunUuid: string | null = datasetOutcome?.dataset_run_id ?? null;
        const datasetId: string | null = datasetOutcome?.dataset_id ?? null;

        if (!ok) {
            // Producer failed (schema/domain/scrape task) — record the run as failed
            // without inferring a dataset. Credits already zeroed by the controller.
            if (jobId) {
                const job = await getJob(jobId);
                if (job) await updateTemplateRunStatus(run.uuid, { legacyJobUuid: job.uuid });
            }
            await appendTemplateRunEvent(run.uuid, "run_failed", {
                http_status: httpStatus,
                error: body?.error ?? null,
                message: body?.message ?? null,
            });
            await finalizeTemplateRun(run.uuid, "failed", {
                stopReason: "producer_failed",
                errorCode: typeof body?.error === "string" ? body.error : "producer_failed",
                errorMessage: typeof body?.message === "string" ? body.message : null,
                statistics: { legacy_job_id: jobId },
                startedAt,
                finishedAt: new Date(),
            });
            return { ok: false, httpStatus, result: body?.data ?? null, jobId, datasetOutcome, errorBody: body };
        }

        // Success. A Dataset write that failed-closed (status !== completed) makes
        // the run `partial`, not `completed` (§6.3 rule 10 / §5 status semantics).
        const datasetFailed = !!datasetOutcome && datasetOutcome.status !== "completed";
        const terminal: "completed" | "partial" = datasetFailed ? "partial" : "completed";

        if (datasetRunUuid) {
            await this.linkDatasetArtifacts(run.uuid, datasetRunUuid);
        }
        const legacyJob = jobId ? await getJob(jobId) : null;
        await updateTemplateRunStatus(run.uuid, { datasetId, datasetRunUuid, legacyJobUuid: legacyJob?.uuid ?? null });
        await appendTemplateRunEvent(run.uuid, `run_${terminal}`, {
            legacy_job_id: jobId,
            dataset: datasetOutcome,
        });
        await finalizeTemplateRun(run.uuid, terminal, {
            stopReason: terminal,
            statistics: { legacy_job_id: jobId, dataset: datasetOutcome ?? null },
            startedAt,
            finishedAt: new Date(),
        });

        return { ok: true, httpStatus, result: body?.data ?? null, jobId, datasetOutcome };
    };

    /**
     * Enqueue a single-mode crawl template ASYNCHRONOUSLY. The crawl runs on the
     * existing worker; the run's live status is derived from the legacy job on
     * read. On success the run is bound to the legacy job and moved to `running`.
     */
    public startCrawlRun = async (params: ExecuteSingleRunParams): Promise<StartCrawlRunResult> => {
        const { run, template, delegatedBody, req } = params;
        req.body = delegatedBody;
        req.resolvedTemplateType = "crawl";
        await appendTemplateRunEvent(run.uuid, "run_dispatched", { mode: "single", template_type: "crawl" });

        const cap = new CapturingResponse();
        await this.crawlController.start(req, cap as unknown as Response);

        const httpStatus = cap.statusCode || 200;
        const body = cap.body ?? {};
        const ok = httpStatus >= 200 && httpStatus < 300 && body?.success === true;
        const jobId: string | null = req.jobId ?? body?.data?.job_id ?? null;
        const datasetId: string | null = body?.data?.dataset_id ?? null;

        if (!ok) {
            await appendTemplateRunEvent(run.uuid, "run_failed", {
                http_status: httpStatus,
                error: body?.error ?? null,
                message: body?.message ?? null,
            });
            await finalizeTemplateRun(run.uuid, "failed", {
                stopReason: "producer_failed",
                errorCode: typeof body?.error === "string" ? body.error : "producer_failed",
                errorMessage: typeof body?.message === "string" ? body.message : null,
                finishedAt: new Date(),
            });
            return { ok: false, httpStatus, jobId, datasetId, body };
        }

        const legacyJob = jobId ? await getJob(jobId) : null;
        await updateTemplateRunStatus(run.uuid, {
            status: "running",
            legacyJobUuid: legacyJob?.uuid ?? null,
            datasetId,
            statistics: { legacy_job_id: jobId },
            startedAt: new Date(),
        });
        await appendTemplateRunEvent(run.uuid, "run_running", { legacy_job_id: jobId });
        return { ok: true, httpStatus, jobId, datasetId, body };
    };

    /**
     * Cancel the legacy crawl job backing a run by reusing CrawlController.cancel
     * (which sets the DB status, the Redis cancel flag and the BullMQ job) via the
     * capturing shim. Best-effort: the run's own cancel state is owned by the
     * caller (requestTemplateRunCancel).
     */
    public cancelCrawlJob = async (jobId: string): Promise<{ httpStatus: number; body: any }> => {
        const cap = new CapturingResponse();
        // CrawlController.cancel only reads req.params.jobId.
        await this.crawlController.cancel({ params: { jobId } } as unknown as RequestWithAuth, cap as unknown as Response);
        return { httpStatus: cap.statusCode || 200, body: cap.body };
    };

    /**
     * Populate the reserved `template_run_uuid` link on the dataset run + its
     * warnings so the run's `/dataset` and `/warnings` feeds resolve. Best-effort:
     * the legacy write already succeeded keyed by dataset_run_id, so a link failure
     * never fails the run.
     */
    private linkDatasetArtifacts = async (templateRunUuid: string, datasetRunUuid: string): Promise<void> => {
        try {
            const db = await getDB();
            await db
                .update(schemas.datasetRuns)
                .set({ templateRunUuid })
                .where(eq(schemas.datasetRuns.uuid, datasetRunUuid));
            await db
                .update(schemas.runWarnings)
                .set({ templateRunUuid })
                .where(eq(schemas.runWarnings.datasetRunId, datasetRunUuid));
        } catch (error) {
            log.warning(
                `[LEGACY-RUN] Failed to link dataset run ${datasetRunUuid} to template run ${templateRunUuid}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    };
}
