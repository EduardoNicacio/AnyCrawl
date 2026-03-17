import type { AxiosInstance, AxiosResponse } from 'axios';
import type {
    CreateWebhookRequest,
    UpdateWebhookRequest,
    Webhook,
    WebhookCreateResponse,
    WebhookDeliveriesResponse,
    WebhookEventsResponse,
} from '../types.js';
import { unwrapApiResponse } from '../utils/index.js';

export async function createWebhook(client: AxiosInstance, input: CreateWebhookRequest): Promise<WebhookCreateResponse> {
    const response: AxiosResponse<unknown> = await client.post('/v1/webhooks', input);
    return unwrapApiResponse<WebhookCreateResponse>(response.data, 'Failed to create webhook');
}

export async function listWebhooks(client: AxiosInstance): Promise<Webhook[]> {
    const response: AxiosResponse<unknown> = await client.get('/v1/webhooks');
    return unwrapApiResponse<Webhook[]>(response.data, 'Failed to list webhooks');
}

export async function getWebhook(client: AxiosInstance, webhookId: string): Promise<Webhook> {
    const response: AxiosResponse<unknown> = await client.get(`/v1/webhooks/${webhookId}`);
    return unwrapApiResponse<Webhook>(response.data, 'Failed to get webhook');
}

export async function updateWebhook(
    client: AxiosInstance,
    webhookId: string,
    input: UpdateWebhookRequest
): Promise<void> {
    const response: AxiosResponse<unknown> = await client.put(`/v1/webhooks/${webhookId}`, input);
    unwrapApiResponse<unknown>(response.data, 'Failed to update webhook');
}

export async function deleteWebhook(client: AxiosInstance, webhookId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.delete(`/v1/webhooks/${webhookId}`);
    unwrapApiResponse<unknown>(response.data, 'Failed to delete webhook');
}

export async function getWebhookDeliveries(
    client: AxiosInstance,
    webhookId: string,
    params?: { limit?: number; offset?: number; status?: string; from?: string; to?: string }
): Promise<WebhookDeliveriesResponse> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    if (params?.status != null) q.set('status', params.status);
    if (params?.from != null) q.set('from', params.from);
    if (params?.to != null) q.set('to', params.to);
    const query = q.toString();
    const url = query ? `/v1/webhooks/${webhookId}/deliveries?${query}` : `/v1/webhooks/${webhookId}/deliveries`;
    const response: AxiosResponse<unknown> = await client.get(url);
    const data = unwrapApiResponse<WebhookDeliveriesResponse['data']>(response.data, 'Failed to get webhook deliveries');
    const raw = response.data as { meta?: WebhookDeliveriesResponse['meta'] };
    return { data: data ?? [], meta: raw?.meta };
}

export async function testWebhook(client: AxiosInstance, webhookId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.post(`/v1/webhooks/${webhookId}/test`);
    unwrapApiResponse<unknown>(response.data, 'Failed to test webhook');
}

export async function activateWebhook(client: AxiosInstance, webhookId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.put(`/v1/webhooks/${webhookId}/activate`);
    unwrapApiResponse<unknown>(response.data, 'Failed to activate webhook');
}

export async function deactivateWebhook(client: AxiosInstance, webhookId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.put(`/v1/webhooks/${webhookId}/deactivate`);
    unwrapApiResponse<unknown>(response.data, 'Failed to deactivate webhook');
}

export async function replayWebhookDelivery(
    client: AxiosInstance,
    webhookId: string,
    deliveryId: string
): Promise<void> {
    const response: AxiosResponse<unknown> = await client.post(
        `/v1/webhooks/${webhookId}/deliveries/${deliveryId}/replay`
    );
    unwrapApiResponse<unknown>(response.data, 'Failed to replay webhook delivery');
}

export async function getWebhookEvents(client: AxiosInstance): Promise<WebhookEventsResponse> {
    const response: AxiosResponse<unknown> = await client.get('/v1/webhook-events');
    const payload = unwrapApiResponse<WebhookEventsResponse>(response.data, 'Failed to get webhook events');
    return {
        event_types: payload?.event_types ?? [],
        categories: payload?.categories ?? {},
    };
}
