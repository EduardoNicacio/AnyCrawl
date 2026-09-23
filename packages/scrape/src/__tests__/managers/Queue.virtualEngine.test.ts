import { describe, expect, it, jest } from "@jest/globals";
import { QueueManager } from "../../managers/Queue.js";

describe("virtual auto engine queues", () => {
    it.each(["scrape-auto", "crawl-auto"])("rejects %s before creating a queue", async queueName => {
        await expect(QueueManager.getInstance().addJob(queueName, {
            url: "https://example.com",
            engine: "auto",
        })).rejects.toThrow("resolve the URL to a concrete engine first");
    });

    it("returns a BullMQ failure immediately instead of waiting for the timeout", async () => {
        const manager = QueueManager.getInstance();
        const status = jest.spyOn(manager, "getJobStatus").mockResolvedValue({
            status: "failed",
            task_status: "pending",
            data: {},
            failedReason: "worker could not start",
        });
        try {
            await expect(manager.waitJobDone("scrape-cheerio", "child", 5000))
                .rejects.toThrow("worker could not start");
        } finally {
            status.mockRestore();
        }
    });

    it("rejects if reading a completed job fails after its state check", async () => {
        const manager = QueueManager.getInstance();
        const status = jest.spyOn(manager, "getJobStatus")
            .mockResolvedValueOnce({ status: "completed", task_status: "completed", data: {} })
            .mockRejectedValueOnce(new Error("Redis read failed"));
        try {
            await expect(manager.waitJobDone("scrape-cheerio", "child", 5000))
                .rejects.toThrow("Redis read failed");
        } finally {
            status.mockRestore();
        }
    });
});
