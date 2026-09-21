import type { PlanLimits } from "./plan-limits.js";

/**
 * Why a scrape failed, in terms a user can act on. Stored on the failed job so
 * the API can decide what to tell the caller.
 *
 * `blocked_by_antibot` is deliberately narrow: only a detected challenge page or
 * a 403/429 from the target counts. Connection failures and empty 200s stay
 * `unreachable` / `target_error` because nothing shows a stealth proxy would help,
 * and pointing users at a paid feature on a guess is worse than saying nothing.
 */
export type FailureClass =
    | "blocked_by_antibot"
    | "target_not_found"
    | "target_error"
    | "timeout"
    | "unreachable"
    | "internal";

export interface FailureSignals {
    /** HTTP status the target returned; 0 or undefined when none was received. */
    statusCode?: number;
    message?: string;
    /** A bot-protection challenge (e.g. Cloudflare) was detected on the page. */
    challengeDetected?: boolean;
}

export function classifyFailure(signals: FailureSignals): FailureClass {
    const { statusCode = 0, message = "", challengeDetected = false } = signals;
    if (challengeDetected) return "blocked_by_antibot";
    if (statusCode === 404 || statusCode === 410) return "target_not_found";
    if (statusCode === 403 || statusCode === 429) return "blocked_by_antibot";
    if (statusCode >= 400) return "target_error";
    if (/timed out|timeout/i.test(message)) return "timeout";
    if (statusCode >= 200) return "target_error";
    return "unreachable";
}

const PRICING_URL = "https://anycrawl.dev/price";

export interface UpgradeHint {
    code: "stealth_proxy_recommended";
    feature: "stealth_proxy";
    min_plan: "hobby";
    message: string;
    url: string;
}

/**
 * What to tell a caller whose scrape was blocked. Only plans without a stealth
 * proxy get one — paid plans already escalate on their own, and self-hosted
 * installs (plan limits off) resolve to UNLIMITED_PLAN_LIMITS, so neither sees an
 * upsell.
 */
export function buildUpgradeHint(failureClass: unknown, limits: PlanLimits): UpgradeHint | null {
    if (failureClass !== "blocked_by_antibot" || limits.stealthProxy) return null;
    return {
        code: "stealth_proxy_recommended",
        feature: "stealth_proxy",
        min_plan: "hobby",
        message:
            "This page appears to be protected by anti-bot measures. Hobby and above can retry with a stealth proxy, which may get through.",
        url: PRICING_URL,
    };
}
