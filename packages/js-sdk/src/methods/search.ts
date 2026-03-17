import type { AxiosInstance, AxiosResponse } from 'axios';
import type { SearchRequest, SearchResult } from '../types.js';
import { buildSearchScrapeOptions, unwrapApiResponse } from '../utils/index.js';

export async function search(client: AxiosInstance, input: SearchRequest): Promise<SearchResult[]> {
    const body: any = { query: input.query };
    if (input.engine != null) body.engine = input.engine;
    if (input.limit != null) body.limit = input.limit;
    if (input.offset != null) body.offset = input.offset;
    if (input.pages != null) body.pages = input.pages;
    if (input.lang != null) body.lang = input.lang;
    if (input.country != null) body.country = input.country;
    if (input.timeRange != null) body.timeRange = input.timeRange;
    if (input.sources != null) body.sources = input.sources;
    if (input.template_id != null) body.template_id = input.template_id;
    if (input.variables != null) body.variables = input.variables;
    const scrapeOptions = buildSearchScrapeOptions(input.scrape_options);
    if (scrapeOptions && Object.keys(scrapeOptions).length > 0) body.scrape_options = scrapeOptions;
    if (input.safe_search != null) body.safe_search = input.safe_search;
    const response: AxiosResponse<unknown> = await client.post('/v1/search', body);
    return unwrapApiResponse<SearchResult[]>(response.data, 'Search failed');
}


