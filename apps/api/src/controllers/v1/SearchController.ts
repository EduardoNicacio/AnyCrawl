import { Response } from "express";
import { z } from "zod";
import { SearchService, SearchServiceError, getSearchConfig } from "@anycrawl/search/SearchService";
import { log } from "@anycrawl/libs/log";
import { searchSchema, RequestWithAuth, CreditCalculator, WebhookEventType, estimateTaskCredits, getCacheConfig, appConfig, getBrowserRuntimeForCache } from "@anycrawl/libs";
import { randomUUID } from "crypto";
import { STATUS, createJob, insertJobResult, completedJob, failedJob, updateJobCounts, updateJobCacheHits, JOB_RESULT_STATUS, writeResultToDataset, assertDatasetWritable, parseDatasetOutput, standardDatasetMapping, DatasetWriteError, type ParsedDatasetOutput, type DatasetMapping } from "@anycrawl/db";
import type { OwnerContext } from "@anycrawl/libs";
import { QueueManager, CacheManager, resolveAutoEngine } from "@anycrawl/scrape";
import { TemplateHandler, validateVariables, applyVariableDefaults } from "../../utils/templateHandler.js";
import { validateTemplateOnlyFields } from "../../utils/templateValidator.js";
import { mergeOptionsWithTemplate } from "../../utils/optionMerger.js";
import { DomainValidator } from "@anycrawl/template-client";
import { renderTextTemplate } from "../../utils/urlTemplate.js";
import { triggerWebhookEvent } from "../../utils/webhookHelper.js";
import { rejectIfPlanForbids } from "../../utils/planGuard.js";

export class SearchController {
    private searchService: SearchService;

    constructor() {
        this.searchService = new SearchService(getSearchConfig());
        log.info("SearchController initialized");
    }

    /**
     * Run the Dataset Writer for the assembled search results and return the
     * `dataset` splice. Fail-closed: Writer errors become `{ status: "failed" }`
     * so search data is never dropped and the response never becomes a 500.
     */
    private writeDatasetSafe = async (args: {
        datasetOutput: ParsedDatasetOutput;
        mapping: DatasetMapping;
        owner: OwnerContext;
        jobId: string;
        result: unknown;
    }): Promise<Record<string, unknown>> => {
        try {
            const outcome = await writeResultToDataset({
                producerType: "search",
                producerId: args.jobId,
                jobId: args.jobId,
                scope: { kind: "job", jobId: args.jobId },
                scopeType: "search",
                result: args.result,
                mapping: args.mapping,
                owner: args.owner,
                dataset: args.datasetOutput.dataset,
            });
            return {
                dataset_id: outcome.datasetId,
                dataset_run_id: outcome.datasetRunId,
                status: outcome.status,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warning(`[SEARCH] Dataset write failed for job ${args.jobId}: ${message}`);
            return { status: "failed", warning: message };
        }
    };

    public handle = async (req: RequestWithAuth, res: Response): Promise<void> => {
        let searchJobId: string | null = null;
        let engineName: string | null = null;
        let defaultPrice: number = 0;
        let pagesProcessed = 0;
        let failedPages = 0;
        let successPages = 0;
        /** Search-template metadata: when false, do not bill scrape template perCall for follow-up scrapes. */
        let chargeScrapeTemplateCreditsForFollowup = true;
        try {
            // Dataset output is an additive, non-schema field: capture from the raw
            // body up front, then strip it before schema parsing so the no-dataset
            // path is unchanged.
            const rawDatasetOutput = (req.body && typeof req.body === "object") ? (req.body as any).output : undefined;

            // Merge template options with request body before parsing
            let requestData = { ...req.body };

            if (requestData.template_id) {
                // Validate: when using template_id, only specific fields are allowed
                if (!validateTemplateOnlyFields(requestData, res, "search")) {
                    return;
                }

                const currentUserId = req.auth?.user ? String(req.auth.user) : undefined;
                requestData = await TemplateHandler.mergeRequestWithTemplate(
                    requestData,
                    "search",
                    currentUserId
                );
                defaultPrice = TemplateHandler.reslovePrice(requestData.template, "credits", "perCall");

                // Re-check the plan on the MERGED options: a request carrying only
                // template_id has no proxy of its own, so the route middleware saw
                // nothing — the stored template supplies it server-side.
                if (rejectIfPlanForbids(req, res, requestData)) return;
                const stMeta = requestData.template?.metadata as { charge_scrape_template_credits?: boolean } | undefined;
                if (stMeta && typeof stMeta.charge_scrape_template_credits === "boolean") {
                    chargeScrapeTemplateCreditsForFollowup = stMeta.charge_scrape_template_credits;
                }

                // Remove template field before schema validation (schemas use strict mode)
                delete requestData.template;
            }

            // Render query template (filters treated as raw for search)
            try {
                if (requestData && typeof requestData.query === "string") {
                    requestData.query = renderTextTemplate(requestData.query, requestData.variables);
                }
            } catch { /* ignore render errors; schema will validate later */ }

            // Never feed `output` to the search schema (unknown keys are stripped,
            // but strip explicitly to keep intent clear and behavior stable).
            if (requestData && typeof requestData === "object") delete (requestData as any).output;

            // Validate and parse the merged data
            const validatedData = searchSchema.parse(requestData);

            // Resolve the dataset output config (null unless output.dataset present).
            const datasetOutput = parseDatasetOutput(rawDatasetOutput, { defaultName: `Search ${validatedData.query}` });
            const datasetMapping = standardDatasetMapping("search");
            const datasetOwner: OwnerContext = { apiKeyId: req.auth?.uuid, userId: req.auth?.user };
            if (datasetOutput) {
                // Eagerly validate an existing dataset before running the search.
                try {
                    await assertDatasetWritable({ owner: datasetOwner, dataset: datasetOutput.dataset, mapping: datasetMapping });
                } catch (dsError) {
                    if (dsError instanceof DatasetWriteError) {
                        req.creditsUsed = 0;
                        req.billingChargeDetails = undefined;
                        res.status(dsError.httpStatus).json({ success: false, error: dsError.code, message: dsError.message });
                        return;
                    }
                    throw dsError;
                }
            }

            let mergedSearchScrapeOptions = validatedData.scrape_options;
            let scrapeFollowTemplatePerCall = 0;
            let scrapeFollowDomainRestriction: ReturnType<typeof DomainValidator.parseDomainRestriction> = undefined;

            if (validatedData.scrape_options?.template_id) {
                const uid = req.auth?.user ? String(req.auth.user) : undefined;
                const tr = await TemplateHandler.getTemplateOptions(
                    validatedData.scrape_options.template_id,
                    "scrape",
                    uid
                );
                if (!tr.success || !tr.template || !tr.templateOptions) {
                    res.status(400).json({
                        success: false,
                        error: "Validation error",
                        message: tr.error || "Invalid scrape template for search follow-up",
                    });
                    return;
                }
                try {
                    validateVariables(
                        tr.template.variables,
                        validatedData.scrape_options.variables,
                        validatedData.scrape_options
                    );
                } catch (ve) {
                    res.status(400).json({
                        success: false,
                        error: "Validation error",
                        message: ve instanceof Error ? ve.message : String(ve),
                    });
                    return;
                }
                const variablesWithDefaults = applyVariableDefaults(
                    tr.template.variables,
                    validatedData.scrape_options.variables
                );
                mergedSearchScrapeOptions = mergeOptionsWithTemplate(
                    tr.templateOptions as Record<string, unknown>,
                    {
                        ...(requestData.scrape_options as Record<string, unknown>),
                        ...(variablesWithDefaults !== undefined ? { variables: variablesWithDefaults } : {}),
                    }
                ) as typeof validatedData.scrape_options;
                // Apply schema defaults only after user values have overridden the
                // scrape template. Parsing first injects engine=auto and timeout=60s,
                // accidentally replacing explicit template defaults.
                // Scrape templates may also define url/retry, which are not
                // follow-up options. Keep only the search endpoint's supported
                // fields while applying its defaults to the merged values.
                mergedSearchScrapeOptions = searchSchema.shape.scrape_options
                    .unwrap().strip().parse(mergedSearchScrapeOptions);
                scrapeFollowTemplatePerCall = TemplateHandler.reslovePrice(tr.template, "credits", "perCall");
                if (!chargeScrapeTemplateCreditsForFollowup) {
                    scrapeFollowTemplatePerCall = 0;
                }
                scrapeFollowDomainRestriction = DomainValidator.parseDomainRestriction(
                    tr.template.metadata?.allowedDomains
                );
            }

            // Operational stop switch for automatic follow-ups. Keep the rest
            // of search available while preventing a bad release from creating
            // another unconsumed queue; never return SERP-only data silently.
            if (mergedSearchScrapeOptions?.engine === "auto" &&
                process.env.ANYCRAWL_SEARCH_FOLLOWUP_AUTO_ENABLED === "false") {
                req.creditsUsed = 0;
                res.status(503).json({
                    success: false,
                    error: "SEARCH_AUTO_FOLLOWUP_DISABLED",
                    message: "Automatic search result scraping is temporarily unavailable",
                });
                return;
            }

            const searchEstimatePayload = {
                ...validatedData,
                scrape_options: mergedSearchScrapeOptions ?? validatedData.scrape_options,
            };

            // Pre-check if user has enough credits
            if (req.auth && appConfig.authEnabled && appConfig.creditsEnabled) {
                const userCredits = req.auth.credits;

                // Use estimateTaskCredits for accurate credit estimation
                const estimatedCredits =
                    defaultPrice +
                    estimateTaskCredits("search", searchEstimatePayload, { scrapeFollowTemplatePerCall });

                if (estimatedCredits > userCredits) {
                    res.status(402).json({
                        success: false,
                        error: "Insufficient credits",
                        message: `Estimated credits required (${estimatedCredits}) exceeds available credits (${userCredits}).`,
                        details: {
                            template_credits: defaultPrice,
                            estimated_total: estimatedCredits,
                            available_credits: userCredits,
                        }
                    });
                    return;
                }
            }

            // Get actual engine name that will be used (resolved by SearchService)
            engineName = this.searchService.resolveEngine(validatedData.engine);

            // Create job for search request (pending)
            searchJobId = randomUUID();
            await createJob({
                job_id: searchJobId,
                job_type: "search",
                job_queue_name: `search-${engineName}`,
                url: `search:${validatedData.query}`,
                req,
                status: STATUS.PENDING,
            });
            req.jobId = searchJobId;
            await req.onTemplateRunJobCreated?.(searchJobId);

            // Trigger search.created webhook
            await triggerWebhookEvent(
                WebhookEventType.SEARCH_CREATED,
                searchJobId,
                {
                    query: validatedData.query,
                    status: "created",
                    engine: engineName,
                },
                "search"
            );

            // Trigger search.started webhook
            await triggerWebhookEvent(
                WebhookEventType.SEARCH_STARTED,
                searchJobId,
                {
                    query: validatedData.query,
                    status: "started",
                },
                "search"
            );

            const expectedPages = validatedData.pages || 1;
            const successfulPages: { page: number; results: any[] }[] = [];
            let completedScrapeCount = 0;
            let totalScrapeCount = 0;
            let cacheHits = 0;

            const results = await this.searchService.search(validatedData.engine, {
                query: validatedData.query,
                limit: validatedData.limit,
                offset: validatedData.offset,
                pages: expectedPages,
                lang: validatedData.lang,
                country: validatedData.country,
                timeRange: validatedData.timeRange,
                sources: validatedData.sources,
                safe_search: validatedData.safe_search,
            }, async (page, pageResults, _uniqueKey, success) => {
                pagesProcessed++;
                if (!success) {
                    failedPages++;
                    try {
                        await insertJobResult(
                            searchJobId!,
                            `search:${engineName}:${validatedData.query}:page:${page}`,
                            { page, query: validatedData.query, results: [] },
                            JOB_RESULT_STATUS.FAILED
                        );
                    } catch (error) {
                        log.error(`[SEARCH] Failed to persist failed page ${page}: ${error}`);
                    }
                    return;
                }
                successPages++;
                // SearchService returns these same result objects. Store them after
                // enrichment so the API, job results and Dataset agree.
                successfulPages.push({ page, results: pageResults });
            });

            if (mergedSearchScrapeOptions && results.length > 0) {
                const scrapeOptions = mergedSearchScrapeOptions;
                const cacheConfig = getCacheConfig();
                const cacheManager = CacheManager.getInstance();
                const queueManager = QueueManager.getInstance();
                const deadlineAt = Date.now() + 60_000;
                const eligibleResults = (results as any[]).filter(result => {
                    if (typeof result?.url !== "string") return false;
                    if (!scrapeFollowDomainRestriction) return true;
                    try {
                        return DomainValidator.validateDomain(
                            result.url, scrapeFollowDomainRestriction
                        ).isValid;
                    } catch {
                        log.warning("[SEARCH] Skipping an invalid follow-up URL");
                        return false;
                    }
                });
                totalScrapeCount = eligibleResults.length;
                let nextResult = 0;

                const enrichOne = async (result: any): Promise<void> => {
                    if (Date.now() >= deadlineAt) return;
                    const resultUrl = result.url as string;
                    try {
                        const engine = scrapeOptions.engine === "auto"
                            ? await resolveAutoEngine(resultUrl, scrapeOptions.proxy)
                            : scrapeOptions.engine!;
                        if (Date.now() >= deadlineAt) return;

                        const maxAge = scrapeOptions.max_age;
                        const shouldCheckCache = cacheConfig.pageCacheEnabled &&
                            (maxAge === undefined || maxAge > 0) &&
                            !scrapeOptions.template_id;
                        const cacheOptions = {
                            engine,
                            browser_runtime: getBrowserRuntimeForCache(engine),
                            formats: scrapeOptions.formats,
                            json_options: scrapeOptions.json_options,
                            include_tags: scrapeOptions.include_tags,
                            exclude_tags: scrapeOptions.exclude_tags,
                            proxy: scrapeOptions.proxy,
                            only_main_content: scrapeOptions.only_main_content,
                            extract_source: scrapeOptions.extract_source,
                            ocr_options: scrapeOptions.ocr_options,
                            wait_for: scrapeOptions.wait_for,
                            wait_until: scrapeOptions.wait_until,
                            wait_for_selector: scrapeOptions.wait_for_selector,
                            template_id: scrapeOptions.template_id,
                            store_in_cache: scrapeOptions.store_in_cache,
                        };
                        if (shouldCheckCache) {
                            try {
                                const cached = await cacheManager.getFromCache(
                                    resultUrl, { ...cacheOptions, url: resultUrl }, maxAge
                                );
                                if (cached && Date.now() < deadlineAt) {
                                    const data: any = { ...cached, maxAge: maxAge ?? cacheConfig.defaultMaxAge };
                                    if ("fromCache" in data) delete data.fromCache;
                                    if (data.screenshot && !String(data.screenshot).startsWith("http")) {
                                        data.screenshot = `${process.env.ANYCRAWL_DOMAIN}/v1/public/storage/file/${data.screenshot}`;
                                    }
                                    if (data["screenshot@fullPage"] && !String(data["screenshot@fullPage"]).startsWith("http")) {
                                        data["screenshot@fullPage"] = `${process.env.ANYCRAWL_DOMAIN}/v1/public/storage/file/${data["screenshot@fullPage"]}`;
                                    }
                                    Object.assign(result, data);
                                    completedScrapeCount++;
                                    cacheHits++;
                                    return;
                                }
                            } catch (cacheError) {
                                log.warning(`[SEARCH] Cache read failed for ${resultUrl}: ${cacheError}`);
                            }
                        }
                        if (Date.now() >= deadlineAt) return;
                        const { engine: _engine, variables: templateVars, ...optionsSansEngine } =
                            scrapeOptions as typeof scrapeOptions & { variables?: Record<string, unknown> };
                        const queueName = `scrape-${engine}`;
                        const jobDeadlineAt = Math.min(deadlineAt, Date.now() + (scrapeOptions.timeout ?? 60_000));
                        const jobId = await queueManager.addJob(queueName, {
                            url: resultUrl,
                            engine,
                            templateVariables: templateVars ?? {},
                            options: optionsSansEngine,
                            parentId: searchJobId!,
                            _anycrawlJobDeadlineAt: jobDeadlineAt,
                        } as any);
                        let accepted = false;
                        try {
                            const waitMs = jobDeadlineAt - Date.now();
                            if (waitMs <= 0) return;
                            const job = await queueManager.waitJobDone(queueName, jobId, waitMs);
                            if (!job || job.status !== "completed" || job.error || Date.now() >= jobDeadlineAt) return;
                            const { uniqueKey, queueName: _queueName, options, engine: _jobEngine,
                                url: _url, type: _type, status: _status, _anycrawlJobDeadlineAt,
                                ...data } = job as any;
                            if (data.screenshot) {
                                data.screenshot = `${process.env.ANYCRAWL_DOMAIN}/v1/public/storage/file/${data.screenshot}`;
                            }
                            if (data["screenshot@fullPage"]) {
                                data["screenshot@fullPage"] = `${process.env.ANYCRAWL_DOMAIN}/v1/public/storage/file/${data["screenshot@fullPage"]}`;
                            }
                            Object.assign(result, data);
                            completedScrapeCount++;
                            accepted = true;
                        } catch (error) {
                            log.warning(`[SEARCH] Follow-up failed for ${resultUrl}: ${error}`);
                        } finally {
                            if (!accepted) {
                                await queueManager.cancelJob(queueName, jobId).catch(() => {});
                            }
                        }
                    } catch (error) {
                        log.warning(`[SEARCH] Follow-up setup failed for ${resultUrl}: ${error}`);
                    }
                };

                await Promise.all(Array.from(
                    { length: Math.min(5, eligibleResults.length) },
                    async () => {
                        while (nextResult < eligibleResults.length && Date.now() < deadlineAt) {
                            const result = eligibleResults[nextResult++];
                            await enrichOne(result);
                        }
                    }
                ));
                if (cacheHits > 0) {
                    await updateJobCacheHits(searchJobId, cacheHits).catch(error =>
                        log.warning(`[SEARCH] Failed to record ${cacheHits} cache hits: ${error}`)
                    );
                }
            }

            const returnedResults = new Set(results);
            for (const { page, results: pageResults } of successfulPages) {
                try {
                    await insertJobResult(
                        searchJobId,
                        `search:${engineName}:${validatedData.query}:page:${page}`,
                        { page, query: validatedData.query, results: pageResults.filter(result => returnedResults.has(result)) },
                        JOB_RESULT_STATUS.SUCCESS
                    );
                } catch (error) {
                    log.error(`[SEARCH] Failed to persist page ${page} for ${searchJobId}: ${error}`);
                }
            }
            try {
                await updateJobCounts(searchJobId, {
                    total: expectedPages + totalScrapeCount,
                    completed: successPages + completedScrapeCount,
                    failed: failedPages + totalScrapeCount - completedScrapeCount,
                });
            } catch (error) {
                log.error(`[SEARCH] Failed to update counts for ${searchJobId}: ${error}`);
            }
            // Calculate credits using CreditCalculator
            req.billingChargeDetails = CreditCalculator.buildSearchChargeDetails({
                pages: validatedData.pages,
                scrape_options: mergedSearchScrapeOptions ?? validatedData.scrape_options,
                completedScrapeCount,
            }, {
                templateCredits: defaultPrice,
                scrapeFollowTemplatePerCall,
            });
            req.creditsUsed = req.billingChargeDetails.total;

            // Mark job status based on page results and scrape tasks
            try {
                const finalTotalTasks = expectedPages + totalScrapeCount;
                const finalCompletedTasks = successPages + completedScrapeCount;
                const finalFailedTasks = failedPages + (totalScrapeCount - completedScrapeCount);

                if (finalFailedTasks >= finalTotalTasks) {
                    await failedJob(
                        searchJobId,
                        `All tasks failed (${finalFailedTasks}/${finalTotalTasks})`,
                        false,
                        { total: finalTotalTasks, completed: finalCompletedTasks, failed: finalFailedTasks }
                    );
                    // Trigger webhook for search failure
                    await triggerWebhookEvent(
                        WebhookEventType.SEARCH_FAILED,
                        searchJobId,
                        {
                            query: validatedData.query,
                            status: "failed",
                            error: `All tasks failed (${finalFailedTasks}/${finalTotalTasks})`,
                            total: finalTotalTasks,
                            completed: finalCompletedTasks,
                            failed: finalFailedTasks,
                        },
                        "search"
                    );
                } else {
                    await completedJob(searchJobId, true, { total: finalTotalTasks, completed: finalCompletedTasks, failed: finalFailedTasks });
                    // Trigger webhook for search completion
                    await triggerWebhookEvent(
                        WebhookEventType.SEARCH_COMPLETED,
                        searchJobId,
                        {
                            query: validatedData.query,
                            status: "completed",
                            total: finalTotalTasks,
                            completed: finalCompletedTasks,
                            failed: finalFailedTasks,
                            results_count: (results as any[]).length,
                        },
                        "search"
                    );
                }
            } catch (e) {
                log.error(`Failed to mark job final status for job_id=${searchJobId}: ${e instanceof Error ? e.message : String(e)}`);
            }
            const searchResponse: Record<string, unknown> = { success: true, data: results };
            if (datasetOutput) {
                searchResponse.dataset = await this.writeDatasetSafe({
                    datasetOutput,
                    mapping: datasetMapping,
                    owner: datasetOwner,
                    jobId: searchJobId!,
                    result: results,
                });
            }
            res.json(searchResponse);
        } catch (error) {
            if (error instanceof z.ZodError) {
                const formattedErrors = error.errors.map((err) => ({
                    field: err.path.join("."),
                    message: err.message,
                    code: err.code,
                }));

                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;
                res.status(400).json({
                    success: false,
                    error: "Validation error",
                    details: {
                        issues: formattedErrors,
                        messages: error.errors.map((err) => err.message),
                    },
                });
            } else {
                if (searchJobId) {
                    try {
                        await failedJob(searchJobId, error instanceof Error ? error.message : "Unknown error", false, {
                            total: pagesProcessed, completed: successPages, failed: failedPages,
                        });
                        if (error instanceof SearchServiceError) {
                            await triggerWebhookEvent(WebhookEventType.SEARCH_FAILED, searchJobId, {
                                status: "failed", error: error.code, message: error.message,
                            }, "search");
                        }
                    } catch (e) {
                        log.error(`Failed to mark job failed for job_id=${searchJobId}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;
                if (error instanceof SearchServiceError) {
                    res.status(error.httpStatus).json({
                        success: false,
                        error: error.code,
                        message: error.message,
                        ...(error.upstreamStatus === undefined ? {} : { upstream_status: error.upstreamStatus }),
                    });
                    return;
                }
                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                    message: error instanceof Error ? error.message : "Unknown error occurred",
                });
            }
        }
    };
}
