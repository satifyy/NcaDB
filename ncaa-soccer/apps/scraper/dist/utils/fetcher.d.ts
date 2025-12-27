import { AxiosRequestConfig } from 'axios';
export interface FetcherConfig {
    delayMs?: number;
    timeout?: number;
    retries?: number;
    userAgent?: string;
    rawDir?: string;
}
export declare class Fetcher {
    private client;
    private config;
    constructor(config?: FetcherConfig);
    private sleep;
    /**
     * Fetch a URL and optionally save the raw HTML.
     * @param url The URL to fetch
     * @param saveAlias Optional alias (e.g., 'SMU_schedule') to use in filename. If not provided, derived from timestamp.
     */
    get(url: string, saveAlias?: string, config?: AxiosRequestConfig): Promise<string>;
}
//# sourceMappingURL=fetcher.d.ts.map