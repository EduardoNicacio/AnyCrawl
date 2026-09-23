import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const addJob = jest.fn(async (_queue: string, _data: any) => "child-1");
const waitJobDone = jest.fn(async (_queue: string, _id: string, _timeout: number): Promise<any> =>
    ({ status: "completed", markdown: "scraped page" }));
const cancelJob = jest.fn(async (_queue: string, _id: string) => {});
const getFromCache = jest.fn(async () => null);
const resolveAutoEngine = jest.fn(async (_url: string, _proxy?: string) => "cheerio");
const insertJobResult = jest.fn(async (..._args: any[]) => {});
const updateJobCounts = jest.fn(async (..._args: any[]) => {});
const completedJob = jest.fn(async (..._args: any[]) => {});
const failedJob = jest.fn(async (..._args: any[]) => {});
const updateJobCacheHits = jest.fn(async (..._args: any[]) => {});
const getTemplateOptions = jest.fn(async (..._args: any[]): Promise<any> => ({ success: false }));
const search = jest.fn(async (_engine: any, _options: any, onPage: any) => {
    const rows = [{ url: "https://example.com/article", title: "Article" }];
    await onPage(1, rows, "google", true);
    return rows;
});

jest.unstable_mockModule("@anycrawl/search/SearchService", () => ({
    SearchService: class {
        resolveEngine = () => "google";
        search = search;
    },
    SearchServiceError: class extends Error {},
    getSearchConfig: () => ({}),
}));
jest.unstable_mockModule("@anycrawl/scrape", () => ({
    QueueManager: { getInstance: () => ({ addJob, waitJobDone, cancelJob }) },
    CacheManager: { getInstance: () => ({ getFromCache }) },
    resolveAutoEngine,
    CrawlerErrorType: {},
}));
jest.unstable_mockModule("@anycrawl/db", () => ({
    STATUS: { PENDING: "pending" },
    JOB_RESULT_STATUS: { SUCCESS: "success", FAILED: "failed" },
    createJob: async () => {},
    insertJobResult,
    completedJob,
    failedJob,
    updateJobCounts,
    updateJobCacheHits,
    writeResultToDataset: async () => ({}),
    assertDatasetWritable: async () => {},
    parseDatasetOutput: () => null,
    standardDatasetMapping: () => ({}),
    DatasetWriteError: class extends Error {},
}));
jest.unstable_mockModule("../utils/templateHandler.js", () => ({
    TemplateHandler: {
        mergeRequestWithTemplate: async (body: any) => body,
        getTemplateOptions,
        reslovePrice: () => 0,
    },
    validateVariables: () => {},
    applyVariableDefaults: () => undefined,
}));
jest.unstable_mockModule("@anycrawl/template-client", () => ({
    DomainValidator: {
        parseDomainRestriction: () => undefined,
        validateDomain: () => ({ isValid: true }),
    },
}));
jest.unstable_mockModule("../utils/webhookHelper.js", () => ({
    triggerWebhookEvent: async () => {},
}));

const { SearchController } = await import("../controllers/v1/SearchController.js");

function response(): any {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (body: any) => { res.body = body; return res; };
    return res;
}

beforeEach(() => {
    jest.clearAllMocks();
    addJob.mockResolvedValue("child-1");
    waitJobDone.mockResolvedValue({ status: "completed", markdown: "scraped page" });
    getFromCache.mockResolvedValue(null);
    resolveAutoEngine.mockResolvedValue("cheerio");
    search.mockImplementation(async (_engine, _options, onPage) => {
        const rows = [{ url: "https://example.com/article", title: "Article" }];
        await onPage(1, rows, "google", true);
        return rows;
    });
});

describe("search result follow-up scraping", () => {
    it("can stop auto follow-ups without enqueueing or charging a request", async () => {
        process.env.ANYCRAWL_SEARCH_FOLLOWUP_AUTO_ENABLED = "false";
        try {
            const req: any = { body: { query: "article", scrape_options: { engine: "auto" } } };
            const res = response();
            await new SearchController().handle(req, res);
            expect(res.statusCode).toBe(503);
            expect(res.body.error).toBe("SEARCH_AUTO_FOLLOWUP_DISABLED");
            expect(req.creditsUsed).toBe(0);
            expect(addJob).not.toHaveBeenCalled();
        } finally {
            delete process.env.ANYCRAWL_SEARCH_FOLLOWUP_AUTO_ENABLED;
        }
    });

    it("resolves auto before enqueue and persists the enriched result", async () => {
        const req: any = { body: { query: "article", pages: 1, limit: 1, scrape_options: { engine: "auto", max_age: 0, timeout: 300000 } } };
        const res = response();
        await new SearchController().handle(req, res);

        expect(addJob).toHaveBeenCalledWith("scrape-cheerio", expect.objectContaining({
            engine: "cheerio", parentId: expect.any(String),
        }));
        expect(waitJobDone.mock.calls[0]?.[2]).toBeLessThanOrEqual(60_000);
        expect(res.statusCode).toBe(200);
        expect(res.body.data[0]).toMatchObject({ title: "Article", markdown: "scraped page" });
        expect(req.creditsUsed).toBe(2);
        expect(insertJobResult).toHaveBeenCalledWith(
            expect.any(String), expect.any(String),
            expect.objectContaining({ results: [expect.objectContaining({ markdown: "scraped page" })] }),
            "success",
        );
    });

    it("leaves plain search requests free of follow-up jobs", async () => {
        const req: any = { body: { query: "article" } };
        const res = response();
        await new SearchController().handle(req, res);

        expect(res.body.data[0]).toEqual({ url: "https://example.com/article", title: "Article" });
        expect(addJob).not.toHaveBeenCalled();
        expect(req.creditsUsed).toBe(1);
    });

    it("merges only successful follow-ups when another result fails", async () => {
        search.mockImplementationOnce(async (_engine, _options, onPage) => {
            const rows = [
                { url: "https://example.com/first", title: "First" },
                { url: "https://example.com/second", title: "Second" },
            ];
            await onPage(1, rows, "google", true);
            return rows;
        });
        addJob.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
        waitJobDone.mockImplementationOnce(async () => ({ status: "completed", markdown: "first page" }))
            .mockImplementationOnce(async () => { throw new Error("second failed"); });
        const req: any = { body: { query: "article", scrape_options: { engine: "auto", max_age: 0 } } };
        const res = response();
        await new SearchController().handle(req, res);

        expect(res.body.data[0]).toMatchObject({ markdown: "first page" });
        expect(res.body.data[1]).toEqual({ url: "https://example.com/second", title: "Second" });
        expect(req.creditsUsed).toBe(2);
        expect(updateJobCounts).toHaveBeenCalledWith(expect.any(String), {
            total: 3, completed: 2, failed: 1,
        });
    });

    it("returns the search row and charges no follow-up when its worker fails", async () => {
        waitJobDone.mockRejectedValueOnce(new Error("worker failed"));
        const req: any = { body: { query: "article", scrape_options: { engine: "auto", max_age: 0 } } };
        const res = response();
        await new SearchController().handle(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.data[0]).toEqual({ url: "https://example.com/article", title: "Article" });
        expect(req.creditsUsed).toBe(1);
        expect(cancelJob).toHaveBeenCalledWith("scrape-cheerio", "child-1");
        expect(completedJob).toHaveBeenCalled();
        expect(failedJob).not.toHaveBeenCalled();
    });

    it("ignores a result that completes after the enrichment deadline", async () => {
        let clock = 1000;
        const now = jest.spyOn(Date, "now").mockImplementation(() => clock);
        waitJobDone.mockImplementationOnce(async () => {
            clock = 62_000;
            return { status: "completed", markdown: "late page" };
        });
        try {
            const req: any = { body: { query: "article", scrape_options: { engine: "auto", max_age: 0 } } };
            const res = response();
            await new SearchController().handle(req, res);
            expect(res.body.data[0]).toEqual({ url: "https://example.com/article", title: "Article" });
            expect(req.creditsUsed).toBe(1);
            expect(cancelJob).toHaveBeenCalledWith("scrape-cheerio", "child-1");
        } finally {
            now.mockRestore();
        }
    });

    it("keeps a scrape template's explicit engine when the caller only supplies its id", async () => {
        getTemplateOptions.mockResolvedValueOnce({
            success: true,
            template: { variables: {}, metadata: {} },
            templateOptions: {
                engine: "playwright", timeout: 7000,
                url: "https://template.example/placeholder", retry: true,
            },
        });
        const req: any = { body: { query: "article", scrape_options: { template_id: "tpl", max_age: 0 } } };
        const res = response();
        await new SearchController().handle(req, res);

        expect(addJob).toHaveBeenCalledWith("scrape-playwright", expect.objectContaining({ engine: "playwright" }));
        expect(resolveAutoEngine).not.toHaveBeenCalled();
        expect(waitJobDone.mock.calls[0]?.[2]).toBeLessThanOrEqual(7000);
        expect(res.statusCode).toBe(200);
    });
});
