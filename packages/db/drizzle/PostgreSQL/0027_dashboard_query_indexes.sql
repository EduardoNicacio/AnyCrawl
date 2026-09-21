CREATE INDEX IF NOT EXISTS "ix_api_key_user" ON "api_key" USING btree ("user");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_job_results_job_uuid" ON "job_results" USING btree ("job_uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_jobs_api_key_created" ON "jobs" USING btree ("api_key_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_scheduled_tasks_user" ON "scheduled_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_task_executions_task_created" ON "task_executions" USING btree ("scheduled_task_uuid","created_at" DESC NULLS LAST);