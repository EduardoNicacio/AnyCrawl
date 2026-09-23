import { HttpClient } from "../HttpClient.js";
import { log } from "@anycrawl/libs";
import { DomainCache } from "./DomainCache.js";

// Do not reuse domain decisions made before HTTP status/content-type validation.
const cache = new DomainCache<{ engine: string }>("ac:engine:v2");

export function analyzeHtmlForJSRequirement(rawHtml: string): {
    jsRequired: boolean;
    score: number;
    reasons: string[];
} {
    const reasons: string[] = [];
    let score = 0;

    const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch?.[1] || "";
    const contentHtml = bodyHtml
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
        .trim();
    const visibleText = contentHtml
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();

    // Strong signals (+3)
    if (
        /id=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(rawHtml)
    ) {
        score += 3;
        reasons.push("empty-root-container");
    }
    if (visibleText.length < 100 && rawHtml.length > 2000) {
        score += 3;
        reasons.push(`minimal-text:${visibleText.length}`);
    }
    const noscriptMatches = rawHtml.match(
        /<noscript[^>]*>([\s\S]*?)<\/noscript>/gi,
    );
    if (noscriptMatches) {
        const noscriptText = noscriptMatches
            .join("")
            .replace(/<[^>]+>/g, "")
            .trim();
        if (noscriptText.length > 30) {
            score += 3;
            reasons.push("noscript-fallback");
        }
    }

    // Medium signals (+1~2)
    const frameworks: [RegExp, string, number][] = [
        [/["']__NEXT_DATA__["']/, "nextjs-data", 1],
        [/__NUXT__/, "nuxt-state", 1],
        [/window\.__INITIAL_STATE__/, "initial-state", 1],
        [/data-reactroot/i, "react-hydrated", 1],
        [/ng-app|ng-controller/i, "angular", 2],
        [/data-svelte/i, "svelte", 1],
    ];
    for (const [pat, name, w] of frameworks) {
        if (pat.test(rawHtml)) {
            score += w;
            reasons.push(`framework:${name}`);
        }
    }
    const scriptCount = (rawHtml.match(/<script/gi) || []).length;
    if (scriptCount > 10 && visibleText.length < 500) {
        score += 2;
        reasons.push(`high-scripts:${scriptCount}`);
    }

    // Counter signals (-1~-3)
    if (visibleText.length > 1000) {
        score -= 3;
        reasons.push(`substantial-text:${visibleText.length}`);
    } else if (visibleText.length > 500) {
        score -= 1;
        reasons.push(`moderate-text:${visibleText.length}`);
    }
    if (/<(?:article|main)[^>]*>[\s\S]{200,}/i.test(contentHtml)) {
        score -= 1;
        reasons.push("has-semantic-content");
    }

    return { jsRequired: score >= 3, score, reasons };
}

export async function resolveAutoEngine(
    url: string,
    proxy?: string,
): Promise<string> {
    let domain: string;
    try {
        domain = new URL(url).hostname;
    } catch {
        throw new Error("Invalid URL for automatic engine selection");
    }

    const cached = await cache.get(domain);
    if (cached) return cached.engine;

    try {
        const res = await HttpClient.get(url, {
            timeoutMs: 5000,
            retries: 0,
            requireProxy: !!proxy,
            proxyMode: proxy,
        });
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Probe returned HTTP ${res.status}`);
        }
        const contentType = res.headers?.["content-type"] || "";
        if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
            throw new Error(`Probe returned unsupported content type: ${contentType || "unknown"}`);
        }
        const analysis = analyzeHtmlForJSRequirement(res.rawText || "");
        const engine = analysis.jsRequired ? "playwright" : "cheerio";
        cache.set(domain, { engine }).catch(() => {});
        log.info(
            `[AutoEngine] ${domain} -> ${engine} (score=${analysis.score}, reasons=${analysis.reasons.join(",")})`,
        );
        return engine;
    } catch (error) {
        const reason = error instanceof Error && error.message.startsWith("Probe returned")
            ? error.message
            : error instanceof Error ? error.name : "unknown";
        log.warning(`[AutoEngine] ${domain} probe failed (${reason}), selecting playwright`);
        return "playwright";
    }
}
