import { afterEach, describe, expect, it } from '@jest/globals';
import { classifyFailure, buildUpgradeHint } from '../failure-class.js';
import { getPlanLimits, UNLIMITED_PLAN_LIMITS } from '../plan-limits.js';

const original = process.env;
afterEach(() => { process.env = original; });

describe('classifyFailure', () => {
    it('treats a detected challenge as anti-bot regardless of status', () => {
        expect(classifyFailure({ statusCode: 200, challengeDetected: true })).toBe('blocked_by_antibot');
        expect(classifyFailure({ statusCode: 0, challengeDetected: true })).toBe('blocked_by_antibot');
    });

    it.each([403, 429])('treats %i from the target as anti-bot', statusCode => {
        expect(classifyFailure({ statusCode })).toBe('blocked_by_antibot');
    });

    it.each([404, 410])('treats %i as a missing page', statusCode => {
        expect(classifyFailure({ statusCode })).toBe('target_not_found');
    });

    it.each([401, 405, 500, 503])('treats %i as a target error, not a block', statusCode => {
        expect(classifyFailure({ statusCode })).toBe('target_error');
    });

    it('does not guess anti-bot from a 200 with no challenge', () => {
        expect(classifyFailure({ statusCode: 200, message: 'Page is not available' })).toBe('target_error');
    });

    it('does not guess anti-bot from a connection failure', () => {
        expect(classifyFailure({ statusCode: 0, message: 'Page is not available' })).toBe('unreachable');
        expect(classifyFailure({})).toBe('unreachable');
    });

    it('recognises timeouts', () => {
        expect(classifyFailure({ statusCode: 0, message: 'Job abc timed out after 60000ms' })).toBe('timeout');
    });
});

describe('buildUpgradeHint', () => {
    it('hints a free caller whose page was blocked', () => {
        process.env = { ...original, ANYCRAWL_API_PLAN_LIMITS_ENABLED: 'true' };
        const hint = buildUpgradeHint('blocked_by_antibot', getPlanLimits('free'));
        expect(hint).toMatchObject({
            code: 'stealth_proxy_recommended',
            feature: 'stealth_proxy',
            min_plan: 'hobby',
        });
        expect(hint?.url).toMatch(/^https:\/\//);
    });

    it.each(['hobby', 'pro', 'business'])('does not upsell %s, which already has stealth', tier => {
        process.env = { ...original, ANYCRAWL_API_PLAN_LIMITS_ENABLED: 'true' };
        expect(buildUpgradeHint('blocked_by_antibot', getPlanLimits(tier))).toBeNull();
    });

    it('never upsells self-hosted installs (plan limits off)', () => {
        process.env = { ...original };
        delete process.env.ANYCRAWL_API_PLAN_LIMITS_ENABLED;
        expect(getPlanLimits('free')).toBe(UNLIMITED_PLAN_LIMITS);
        expect(buildUpgradeHint('blocked_by_antibot', getPlanLimits('free'))).toBeNull();
    });

    it.each(['target_not_found', 'target_error', 'timeout', 'unreachable', 'internal', undefined, 'x'])(
        'stays silent for failure class %p',
        failureClass => {
            process.env = { ...original, ANYCRAWL_API_PLAN_LIMITS_ENABLED: 'true' };
            expect(buildUpgradeHint(failureClass, getPlanLimits('free'))).toBeNull();
        }
    );
});
