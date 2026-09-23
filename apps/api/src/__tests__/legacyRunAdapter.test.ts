import { jest, describe, it, expect } from "@jest/globals";

const updateTemplateRunStatus = jest.fn(async (_id: string, _patch: any) => ({}));
const appendTemplateRunEvent = jest.fn(async (_id: string, _type: string, _data?: any) => ({}));
const finalizeTemplateRun = jest.fn(async (_id: string, _status: string, _data?: any) => ({}));
const getJob = jest.fn(async (_id: string) => ({ uuid: "database-job-uuid", jobId: "queue-job-id" }));
const scrapeHandle = jest.fn(async (req: any, res: any) => {
    req.jobId = "queue-job-id";
    await req.onTemplateRunJobCreated?.(req.jobId);
    res.json({ success: true, data: { title: "Done" } });
});

jest.unstable_mockModule("@anycrawl/db", () => ({
    updateTemplateRunStatus,
    appendTemplateRunEvent,
    finalizeTemplateRun,
    getJob,
    getJobByUuid: jest.fn(),
    failedJob: jest.fn(),
    getDB: jest.fn(),
    schemas: {},
    eq: jest.fn(),
}));
jest.unstable_mockModule("@anycrawl/scrape", () => ({ QueueManager: { getInstance: jest.fn() } }));
jest.unstable_mockModule("../controllers/v1/ScrapeController.js", () => ({
    ScrapeController: class { handle = scrapeHandle; },
}));
jest.unstable_mockModule("../controllers/v1/SearchController.js", () => ({
    SearchController: class { handle = jest.fn(); },
}));
jest.unstable_mockModule("../controllers/v1/CrawlController.js", () => ({
    CrawlController: class { start = jest.fn(); cancel = jest.fn(); },
}));

const { LegacyRunAdapter } = await import("../services/LegacyRunAdapter.js");

describe("LegacyRunAdapter single scrape", () => {
    it("persists the database job UUID while preserving the queue job ID in results", async () => {
        const req: any = { auth: { user: "owner", uuid: "key" } };
        const result = await new LegacyRunAdapter().executeSingleRun({
            run: { uuid: "run-uuid" },
            template: { templateType: "scrape" },
            delegatedBody: { template_id: "template", url: "https://example.com" },
            req,
        });

        expect(result.ok).toBe(true);
        expect(result.jobId).toBe("queue-job-id");
        expect(updateTemplateRunStatus).toHaveBeenCalledWith("run-uuid", {
            legacyJobUuid: "database-job-uuid",
            statistics: { legacy_job_id: "queue-job-id" },
        });
        expect(finalizeTemplateRun).toHaveBeenCalledWith("run-uuid", "completed", expect.anything());
        expect(req.templateRunDeadlineAt).toBeGreaterThan(Date.now());
    });
});
