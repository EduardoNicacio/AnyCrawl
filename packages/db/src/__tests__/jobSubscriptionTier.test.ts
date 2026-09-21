import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { eq, sql } from 'drizzle-orm';
import { STATUS } from '../map.js';

const apiKey = sqliteTable('api_key', {
    uuid: text('uuid').primaryKey(),
    subscriptionTier: text('subscription_tier').notNull(),
});
const jobs = sqliteTable('jobs', {
    jobId: text('job_id').primaryKey(),
    apiKey: text('api_key_id'),
});
const connection = new Database(':memory:');
connection.exec('CREATE TABLE api_key (uuid TEXT PRIMARY KEY, subscription_tier TEXT NOT NULL)');
connection.exec('CREATE TABLE jobs (job_id TEXT PRIMARY KEY, api_key_id TEXT)');
const db = drizzle(connection);
jest.unstable_mockModule('../index.js', () => ({ getDB: async () => db, schemas: { jobs, apiKey }, eq, sql, STATUS }));
const { Job } = await import('../model/Job.js');

beforeEach(() => {
    connection.exec(`
        DELETE FROM jobs; DELETE FROM api_key;
        INSERT INTO api_key VALUES ('k-free', 'free'), ('k-pro', 'pro');
        INSERT INTO jobs VALUES ('job-free', 'k-free'), ('job-pro', 'k-pro'), ('job-nokey', NULL), ('job-orphan', 'k-gone');
    `);
});
afterAll(() => { connection.close(); });

describe('Job.getSubscriptionTier', () => {
    it("returns the tier of the job's API key", async () => {
        expect(await Job.getSubscriptionTier('job-free')).toBe('free');
        expect(await Job.getSubscriptionTier('job-pro')).toBe('pro');
    });

    it('returns null when the job has no key, its key is gone, or the job is unknown', async () => {
        expect(await Job.getSubscriptionTier('job-nokey')).toBeNull();
        expect(await Job.getSubscriptionTier('job-orphan')).toBeNull();
        expect(await Job.getSubscriptionTier('nope')).toBeNull();
    });
});
