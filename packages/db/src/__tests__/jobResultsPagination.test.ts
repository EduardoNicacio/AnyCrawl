import { afterAll, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { eq, sql } from 'drizzle-orm';
import { STATUS } from '../map.js';

const jobs = sqliteTable('jobs', {
    uuid: text('uuid').primaryKey(),
    jobId: text('job_id').notNull(),
});
const jobResults = sqliteTable('job_results', {
    uuid: text('uuid').primaryKey(),
    jobUuid: text('job_uuid'),
    url: text('url').notNull(),
    data: text('data', { mode: 'json' }),
    status: text('status').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
const connection = new Database(':memory:');
connection.exec('CREATE TABLE jobs (uuid TEXT PRIMARY KEY, job_id TEXT NOT NULL)');
connection.exec('CREATE TABLE job_results (uuid TEXT PRIMARY KEY, job_uuid TEXT, url TEXT NOT NULL, data TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
const db = drizzle(connection);
jest.unstable_mockModule('../index.js', () => ({ getDB: async () => db, schemas: { jobs, jobResults }, eq, sql, STATUS }));
const { Job } = await import('../model/Job.js');
afterAll(() => connection.close());

describe('job result pagination for Run output', () => {
    it('returns only successful rows for the backing job in stable order', async () => {
        connection.exec("INSERT INTO jobs (uuid, job_id) VALUES ('job-uuid', 'queue-id'), ('other-uuid', 'other-id')");
        const at = new Date('2026-09-24T00:00:00Z');
        await db.insert(jobResults).values([
            { uuid: 'b', jobUuid: 'job-uuid', url: 'https://b.test', data: { title: 'B' }, status: 'success', createdAt: at, updatedAt: at },
            { uuid: 'a', jobUuid: 'job-uuid', url: 'https://a.test', data: { title: 'A' }, status: 'success', createdAt: at, updatedAt: at },
            { uuid: 'c', jobUuid: 'job-uuid', url: 'https://c.test', data: {}, status: 'failed', createdAt: at, updatedAt: at },
            { uuid: 'd', jobUuid: 'other-uuid', url: 'https://d.test', data: {}, status: 'success', createdAt: at, updatedAt: at },
        ]);

        const rows = await Job.getJobResultsPaginated('queue-id', 0, 3, 'success');
        expect(rows.map((row: any) => row.uuid)).toEqual(['a', 'b']);
        expect(rows[0]?.data).toEqual({ title: 'A' });
    });
});
