import type { AxiosInstance, AxiosResponse } from 'axios';
import type { MapRequest, MapResult, MapLink } from '../types.js';
import { Logger } from '../logger.js';
import { unwrapApiResponse } from '../utils/index.js';
const log = new Logger();

/**
 * Map a website to discover all URLs.
 *
 * @param client Axios instance
 * @param input Map request parameters
 * @returns Map result with list of discovered URLs
 */
export async function map(client: AxiosInstance, input: MapRequest): Promise<MapResult> {
    log.debug('Calling /v1/map');
    const response: AxiosResponse<unknown> = await client.post('/v1/map', input);
    const links = unwrapApiResponse<MapLink[]>(response.data, 'Map request failed');
    return { links: links || [] };
}
