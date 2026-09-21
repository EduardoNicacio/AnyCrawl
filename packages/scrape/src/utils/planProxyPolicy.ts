import { getPlanLimits, log, type PlanLimits } from "@anycrawl/libs";
import { getJobSubscriptionTier } from "@anycrawl/db";

/**
 * On a plan without a stealth proxy, `auto` (which escalates to stealth after a
 * block) and an explicit `stealth` both run as `base`. Every other value —
 * `base`, a custom proxy URL, or no proxy at all — is left as it was.
 */
export function clampProxyForPlan<T extends { proxy?: unknown }>(options: T, limits: PlanLimits): T {
    if (limits.stealthProxy) return options;
    if (options?.proxy !== "auto" && options?.proxy !== "stealth") return options;
    return { ...options, proxy: "base" };
}

const TIER_TTL_MS = 60_000;
const TIER_CACHE_MAX = 500;
const tierCache = new Map<string, { tier: string | null; at: number }>();

async function tierForJob(jobId: string): Promise<string | null> {
    const hit = tierCache.get(jobId);
    if (hit && Date.now() - hit.at < TIER_TTL_MS) return hit.tier;
    const tier = await getJobSubscriptionTier(jobId);
    if (tierCache.size >= TIER_CACHE_MAX) tierCache.delete(tierCache.keys().next().value as string);
    tierCache.set(jobId, { tier, at: Date.now() });
    return tier;
}

/**
 * Apply the caller's plan to a job's scrape options. Fails open: when plan limits
 * are off, the job has no known key, or the lookup errors, the options are
 * returned untouched — a broken lookup must never stop a scrape.
 */
export async function applyPlanProxyPolicy<T extends { proxy?: unknown }>(options: T, jobId: string): Promise<T> {
    const proxy = options?.proxy;
    if (proxy !== "auto" && proxy !== "stealth") return options;
    try {
        const tier = await tierForJob(jobId);
        if (!tier) return options;
        const clamped = clampProxyForPlan(options, getPlanLimits(tier));
        if (clamped !== options) {
            log.info(`[PLAN] job ${jobId}: tier "${tier}" has no stealth proxy, proxy "${String(proxy)}" -> "base"`);
        }
        return clamped;
    } catch (error) {
        log.warning(`[PLAN] proxy policy lookup failed for job ${jobId}, leaving options unchanged: ${error instanceof Error ? error.message : String(error)}`);
        return options;
    }
}

export function resetPlanProxyPolicyCache(): void {
    tierCache.clear();
}
