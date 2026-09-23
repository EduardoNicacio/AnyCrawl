import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const get = jest.fn(async (_url: string, _options: any): Promise<any> => ({
    status: 200,
    headers: { "content-type": "text/html" },
    rawText: "<html><body><article>Static page content</article></body></html>",
}));
const cacheGet = jest.fn(async (_domain: string): Promise<any> => null);
const cacheSet = jest.fn(async (_domain: string, _value: any) => {});

jest.unstable_mockModule("./src/HttpClient.js", () => ({ HttpClient: { get } }));
jest.unstable_mockModule("./src/utils/DomainCache.js", () => ({
    DomainCache: class {
        get = cacheGet;
        set = cacheSet;
    },
}));

const { resolveAutoEngine } = await import("../../utils/autoEngine.js");

beforeEach(() => {
    jest.clearAllMocks();
    cacheGet.mockResolvedValue(null);
    get.mockResolvedValue({
        status: 200,
        headers: { "content-type": "text/html" },
        rawText: "<html><body><article>Static page content</article></body></html>",
    });
});

describe("automatic engine selection", () => {
    it("selects cheerio for HTML and passes the requested proxy policy to the probe", async () => {
        expect(await resolveAutoEngine("https://example.com/article", "http://proxy.example:8080"))
            .toBe("cheerio");
        expect(get).toHaveBeenCalledWith("https://example.com/article", expect.objectContaining({
            timeoutMs: 5000,
            retries: 0,
            requireProxy: true,
            proxyMode: "http://proxy.example:8080",
        }));
        expect(cacheSet).toHaveBeenCalledWith("example.com", { engine: "cheerio" });
    });

    it("selects playwright when the initial HTML needs JavaScript", async () => {
        get.mockResolvedValueOnce({
            status: 200,
            headers: { "content-type": "text/html" },
            rawText: "<html><body><div id='root'></div></body></html>",
        });
        expect(await resolveAutoEngine("https://example.com/app")).toBe("playwright");
    });

    it("does not cache an HTTP error page as a static page", async () => {
        get.mockResolvedValueOnce({
            status: 403,
            headers: { "content-type": "text/html" },
            rawText: "<html><body>Blocked</body></html>",
        });
        expect(await resolveAutoEngine("https://example.com/blocked")).toBe("playwright");
        expect(cacheSet).not.toHaveBeenCalled();
    });

    it("uses a cached decision without probing again", async () => {
        cacheGet.mockResolvedValueOnce({ engine: "playwright" });
        expect(await resolveAutoEngine("https://example.com/app")).toBe("playwright");
        expect(get).not.toHaveBeenCalled();
    });
});
