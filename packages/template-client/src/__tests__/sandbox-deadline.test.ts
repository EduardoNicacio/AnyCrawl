import { describe, expect, it } from "@jest/globals";
import { QuickJSSandbox } from "../sandbox/index.js";

describe("template sandbox job deadline", () => {
    const context = (trusted: boolean, deadlineAt: number): any => ({
        template: { templateId: "deadline-test", trusted, metadata: {} },
        executionContext: { userData: { _anycrawlJobDeadlineAt: deadlineAt } },
        variables: {},
    });

    it.each([true, false])("stops an async handler at the job deadline (trusted=%s)", async (trusted) => {
        const sandbox = new QuickJSSandbox({ timeout: 600_000 });
        const started = Date.now();
        await expect(sandbox.executeCode(
            "await new Promise(() => {});",
            context(trusted, Date.now() + 100)
        )).rejects.toThrow(/Execution timeout/);
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it("rejects an already expired job before executing its handler", async () => {
        const sandbox = new QuickJSSandbox({ timeout: 600_000 });
        await expect(sandbox.executeCode(
            "return 'too late';",
            context(true, Date.now() - 1)
        )).rejects.toThrow("Browser task deadline exceeded");
    });
});
