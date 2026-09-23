import { describe, expect, it } from "@jest/globals";
import { createProxySelectionRequest } from "../HttpClient.js";

describe("auto engine preflight proxy policy", () => {
    it("passes the selected proxy mode to the crawler's proxy selector", () => {
        const url = "https://example.com/article";
        const customProxy = "http://proxy.example:8080";
        const request = createProxySelectionRequest(url, customProxy);
        expect(request.url).toBe(url);
        expect(request.userData).toMatchObject({
            options: { proxy: customProxy },
            original_url: url,
        });
    });
});
