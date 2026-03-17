import type { AxiosInstance, AxiosResponse } from 'axios';
import type {
    CreateScheduledTaskRequest,
    UpdateScheduledTaskRequest,
    ScheduledTask,
    ScheduledTaskCreateResponse,
    ScheduledTaskExecution,
    ScheduledTaskExecutionsResponse,
} from '../types.js';
import { unwrapApiResponse } from '../utils/index.js';

export async function createScheduledTask(
    client: AxiosInstance,
    input: CreateScheduledTaskRequest
): Promise<ScheduledTaskCreateResponse> {
    const response: AxiosResponse<unknown> = await client.post('/v1/scheduled-tasks', input);
    return unwrapApiResponse<ScheduledTaskCreateResponse>(response.data, 'Failed to create scheduled task');
}

export async function listScheduledTasks(client: AxiosInstance): Promise<ScheduledTask[]> {
    const response: AxiosResponse<unknown> = await client.get('/v1/scheduled-tasks');
    return unwrapApiResponse<ScheduledTask[]>(response.data, 'Failed to list scheduled tasks');
}

export async function getScheduledTask(client: AxiosInstance, taskId: string): Promise<ScheduledTask> {
    const response: AxiosResponse<unknown> = await client.get(`/v1/scheduled-tasks/${taskId}`);
    return unwrapApiResponse<ScheduledTask>(response.data, 'Failed to get scheduled task');
}

export async function updateScheduledTask(
    client: AxiosInstance,
    taskId: string,
    input: UpdateScheduledTaskRequest
): Promise<ScheduledTask> {
    const response: AxiosResponse<unknown> = await client.put(`/v1/scheduled-tasks/${taskId}`, input);
    return unwrapApiResponse<ScheduledTask>(response.data, 'Failed to update scheduled task');
}

export async function pauseScheduledTask(
    client: AxiosInstance,
    taskId: string,
    reason?: string
): Promise<void> {
    const response: AxiosResponse<unknown> = await client.patch(
        `/v1/scheduled-tasks/${taskId}/pause`,
        reason != null ? { reason } : {}
    );
    unwrapApiResponse<unknown>(response.data, 'Failed to pause scheduled task');
}

export async function resumeScheduledTask(client: AxiosInstance, taskId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.patch(`/v1/scheduled-tasks/${taskId}/resume`);
    unwrapApiResponse<unknown>(response.data, 'Failed to resume scheduled task');
}

export async function deleteScheduledTask(client: AxiosInstance, taskId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.delete(`/v1/scheduled-tasks/${taskId}`);
    unwrapApiResponse<unknown>(response.data, 'Failed to delete scheduled task');
}

export async function getScheduledTaskExecutions(
    client: AxiosInstance,
    taskId: string,
    params?: { limit?: number; offset?: number }
): Promise<ScheduledTaskExecutionsResponse> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const query = q.toString();
    const url = query ? `/v1/scheduled-tasks/${taskId}/executions?${query}` : `/v1/scheduled-tasks/${taskId}/executions`;
    const response: AxiosResponse<unknown> = await client.get(url);
    const data = unwrapApiResponse<ScheduledTaskExecution[]>(response.data, 'Failed to get task executions');
    const raw = response.data as { meta?: { limit: number; offset: number } };
    return { data: data ?? [], meta: raw?.meta };
}

export async function cancelScheduledTaskExecution(
    client: AxiosInstance,
    taskId: string,
    executionId: string
): Promise<void> {
    const response: AxiosResponse<unknown> = await client.delete(
        `/v1/scheduled-tasks/${taskId}/executions/${executionId}`
    );
    unwrapApiResponse<unknown>(response.data, 'Failed to cancel scheduled task execution');
}
