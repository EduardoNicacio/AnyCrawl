import { describe, expect, it } from '@jest/globals';
import { failureMetadata } from '../../engines/failureMetadata.js';

describe('failureMetadata', () => {
    it('lifts the real error message out of an Error thrown behind a 200', () => {
        const meta = failureMetadata({
            statusCode: 200,
            message: 'Page is not available: 200 OK',
            data: new Error('Navigation timeout of 30000 ms exceeded'),
            challengeDetected: false,
        });
        expect(meta.cause).toBe('Navigation timeout of 30000 ms exceeded');
        expect(meta.failure_class).toBe('timeout');
    });

    it('marks an unresolved challenge as anti-bot even behind a 200', () => {
        expect(failureMetadata({ statusCode: 200, message: 'Page is not available: 200 OK', challengeDetected: true }))
            .toEqual({ failure_class: 'blocked_by_antibot' });
    });

    it('classifies a target 404 without adding a cause', () => {
        expect(failureMetadata({ statusCode: 404, message: 'Page is not available: 404 Not Found', challengeDetected: false }))
            .toEqual({ failure_class: 'target_not_found' });
    });

    it('ignores non-Error data', () => {
        const meta = failureMetadata({ statusCode: 500, message: 'x', data: { foo: 1 }, challengeDetected: false });
        expect(meta.cause).toBeUndefined();
        expect(meta.failure_class).toBe('target_error');
    });

    it('caps a very long cause', () => {
        const meta = failureMetadata({
            statusCode: 200,
            message: 'x',
            data: new Error('e'.repeat(1000)),
            challengeDetected: false,
        });
        expect(meta.cause).toHaveLength(300);
    });
});
