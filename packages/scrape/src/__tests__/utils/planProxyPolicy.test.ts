import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getJobSubscriptionTier = jest.fn<(jobId: string) => Promise<string | null>>();

jest.unstable_mockModule('@anycrawl/db', () => ({ getJobSubscriptionTier }));

const { applyPlanProxyPolicy, clampProxyForPlan, resetPlanProxyPolicyCache } = await import('../../utils/planProxyPolicy.js');
const { getPlanLimits } = await import('@anycrawl/libs');

const original = process.env;

beforeEach(() => {
    process.env = { ...original, ANYCRAWL_API_PLAN_LIMITS_ENABLED: 'true' };
    getJobSubscriptionTier.mockReset();
    resetPlanProxyPolicyCache();
});
afterEach(() => { process.env = original; });

describe('clampProxyForPlan', () => {
    it.each(['auto', 'stealth'])('runs %s as base on a plan without stealth', proxy => {
        expect(clampProxyForPlan({ proxy }, getPlanLimits('free'))).toEqual({ proxy: 'base' });
    });

    it.each(['base', 'http://user:pw@proxy.example:8080', undefined])('leaves %p alone', proxy => {
        const options = { proxy };
        expect(clampProxyForPlan(options, getPlanLimits('free'))).toBe(options);
    });

    it.each(['hobby', 'pro', 'business'])('never touches %s', tier => {
        const options = { proxy: 'auto' };
        expect(clampProxyForPlan(options, getPlanLimits(tier))).toBe(options);
    });

    it('does not mutate the caller’s object', () => {
        const options = { proxy: 'auto', timeout: 5 };
        const out = clampProxyForPlan(options, getPlanLimits('free'));
        expect(options.proxy).toBe('auto');
        expect(out).toEqual({ proxy: 'base', timeout: 5 });
    });
});

describe('applyPlanProxyPolicy', () => {
    it('downgrades auto for a free-tier job', async () => {
        getJobSubscriptionTier.mockResolvedValue('free');
        expect(await applyPlanProxyPolicy({ proxy: 'auto' }, 'job-1')).toEqual({ proxy: 'base' });
    });

    it('keeps auto for a paid-tier job', async () => {
        getJobSubscriptionTier.mockResolvedValue('hobby');
        const options = { proxy: 'auto' };
        expect(await applyPlanProxyPolicy(options, 'job-2')).toBe(options);
    });

    it('is inert when plan limits are off (self-hosted), without touching the database', async () => {
        delete process.env.ANYCRAWL_API_PLAN_LIMITS_ENABLED;
        getJobSubscriptionTier.mockResolvedValue('free');
        const options = { proxy: 'auto' };
        expect(await applyPlanProxyPolicy(options, 'job-3')).toBe(options);
    });

    it('fails open when the job has no known key', async () => {
        getJobSubscriptionTier.mockResolvedValue(null);
        const options = { proxy: 'auto' };
        expect(await applyPlanProxyPolicy(options, 'job-4')).toBe(options);
    });

    it('fails open when the lookup throws', async () => {
        getJobSubscriptionTier.mockRejectedValue(new Error('db down'));
        const options = { proxy: 'auto' };
        expect(await applyPlanProxyPolicy(options, 'job-5')).toBe(options);
    });

    it('does not look anything up for options that cannot escalate', async () => {
        await applyPlanProxyPolicy({ proxy: 'base' }, 'job-6');
        await applyPlanProxyPolicy({}, 'job-7');
        expect(getJobSubscriptionTier).not.toHaveBeenCalled();
    });

    it('looks a job up once, so a crawl’s pages share one query', async () => {
        getJobSubscriptionTier.mockResolvedValue('free');
        await applyPlanProxyPolicy({ proxy: 'auto' }, 'crawl-1');
        await applyPlanProxyPolicy({ proxy: 'auto' }, 'crawl-1');
        await applyPlanProxyPolicy({ proxy: 'auto' }, 'crawl-1');
        expect(getJobSubscriptionTier).toHaveBeenCalledTimes(1);
    });
});
