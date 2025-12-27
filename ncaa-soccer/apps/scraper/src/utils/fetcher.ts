import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import axiosRetry from 'axios-retry';
import * as fs from 'fs';
import * as path from 'path';

export interface FetcherConfig {
    delayMs?: number;
    timeout?: number;
    retries?: number;
    userAgent?: string;
    rawDir?: string;
    quiet?: boolean;
}

export class Fetcher {
    private client: AxiosInstance;
    private config: FetcherConfig;

    constructor(config: FetcherConfig = {}) {
        this.config = {
            delayMs: 1000,
            timeout: 10000,
            retries: 3,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            rawDir: path.resolve(process.cwd(), 'data/raw'), // Default to data/raw in root
            ...config
        };

        this.client = axios.create({
            timeout: this.config.timeout,
            headers: {
                'User-Agent': this.config.userAgent
            }
        });

        axiosRetry(this.client, {
            retries: this.config.retries,
            retryDelay: axiosRetry.exponentialDelay,
            retryCondition: (error) => {
                return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
                    (error.response?.status ? error.response.status >= 500 : false);
            }
        });

        // Ensure raw directory exists
        if (this.config.rawDir && !fs.existsSync(this.config.rawDir)) {
            fs.mkdirSync(this.config.rawDir, { recursive: true });
        }
    }

    private async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Fetch a URL and optionally save the raw HTML.
     * @param url The URL to fetch
     * @param saveAlias Optional alias (e.g., 'SMU_schedule') to use in filename. If not provided, derived from timestamp.
     */
    async get(url: string, saveAlias?: string, config?: AxiosRequestConfig): Promise<string> {
        if (this.config.delayMs && this.config.delayMs > 0) {
            await this.sleep(this.config.delayMs);
        }

        try {
            if (!this.config.quiet) console.log(`Fetching ${url}...`);
            const response = await this.client.get(url, config);
            let html = response.data;

            if (typeof html === 'object') {
                html = JSON.stringify(html, null, 2);
            }

            if (this.config.rawDir) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const slug = saveAlias ? saveAlias.replace(/[^a-zA-Z0-9_-]/g, '_') : 'unknown';
                const filename = `${timestamp}_${slug}.html`;
                const filepath = path.join(this.config.rawDir, filename);

                fs.writeFileSync(filepath, html);
                if (!this.config.quiet) console.log(`Saved raw HTML to ${filepath}`);
            }

            return html;
        } catch (error: any) {
            console.error(`Failed to fetch ${url}: ${error.message}`);
            throw error;
        }
    }
}
