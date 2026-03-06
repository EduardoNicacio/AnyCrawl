import { describe, expect, it } from "@jest/globals";
import { shouldCache } from "../cache/index.js";

describe("shouldCache", () => {
    it("returns false for title-only markdown payloads", () => {
        const options = {};
        const result = {
            title: "Labor market reforms and unemployment fluctuations | Oxford Economic Papers | Oxford Academic",
            metadata: [],
            markdown: "Labor market reforms and unemployment fluctuations | Oxford Economic Papers | Oxford Academic",
        };

        expect(shouldCache(options, result)).toBe(false);
    });

    it("returns true when markdown contains real body content", () => {
        const options = {};
        const result = {
            title: "Example Page",
            metadata: [],
            markdown: "# Example Page\n\nThis page contains substantive body text.",
        };

        expect(shouldCache(options, result)).toBe(true);
    });

    it("returns true for screenshot-only payloads", () => {
        const options = {};
        const result = {
            title: "Screenshot Result",
            metadata: [],
            screenshot: "screenshot-job-abc.jpeg",
        };

        expect(shouldCache(options, result)).toBe(true);
    });
});
