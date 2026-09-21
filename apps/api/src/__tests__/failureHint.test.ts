import { afterEach, describe, expect, it } from '@jest/globals';
import { RequestWithAuth } from '@anycrawl/libs';
import { failureFields } from '../utils/failureHint.js';

const original = process.env;
afterEach(() => { process.env = original; });

const reqFor = (tier: string): RequestWithAuth =>
    ({ auth: { uuid: 'k', subscriptionTier: tier } }) as unknown as RequestWithAuth;

function plansOn() {
    process.env = { ...original, ANYCRAWL_API_PLAN_LIMITS_ENABLED: 'true' };
}

describe('failureFields', () => {
    it('adds the failure class and an upgrade hint for a blocked free caller', () => {
        plansOn();
        const fields = failureFields(reqFor('free'), { failure_class: 'blocked_by_antibot' });
        expect(fields.error_code).toBe('blocked_by_antibot');
        expect(fields.upgrade).toMatchObject({ feature: 'stealth_proxy', min_plan: 'hobby' });
    });

    it.each(['hobby', 'pro', 'business'])('reports the class but no upsell for %s', tier => {
        plansOn();
        const fields = failureFields(reqFor(tier), { failure_class: 'blocked_by_antibot' });
        expect(fields).toEqual({ error_code: 'blocked_by_antibot' });
    });

    it('does not upsell a free caller when the page was simply missing', () => {
        plansOn();
        expect(failureFields(reqFor('free'), { failure_class: 'target_not_found' }))
            .toEqual({ error_code: 'target_not_found' });
    });

    it('never upsells a self-hosted install', () => {
        process.env = { ...original };
        delete process.env.ANYCRAWL_API_PLAN_LIMITS_ENABLED;
        expect(failureFields(reqFor('free'), { failure_class: 'blocked_by_antibot' }))
            .toEqual({ error_code: 'blocked_by_antibot' });
    });

    it('adds nothing when the worker recorded no class (older jobs, internal errors)', () => {
        plansOn();
        expect(failureFields(reqFor('free'), {})).toEqual({});
        expect(failureFields(reqFor('free'), undefined)).toEqual({});
        expect(failureFields(reqFor('free'), { failure_class: 42 })).toEqual({});
    });
});
