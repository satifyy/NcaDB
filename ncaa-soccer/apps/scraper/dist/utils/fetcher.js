"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Fetcher = void 0;
const axios_1 = __importDefault(require("axios"));
const axios_retry_1 = __importDefault(require("axios-retry"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class Fetcher {
    constructor(config = {}) {
        this.config = {
            delayMs: 1000,
            timeout: 10000,
            retries: 3,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            rawDir: path.resolve(process.cwd(), 'data/raw'), // Default to data/raw in root
            ...config
        };
        this.client = axios_1.default.create({
            timeout: this.config.timeout,
            headers: {
                'User-Agent': this.config.userAgent
            }
        });
        (0, axios_retry_1.default)(this.client, {
            retries: this.config.retries,
            retryDelay: axios_retry_1.default.exponentialDelay,
            retryCondition: (error) => {
                return axios_retry_1.default.isNetworkOrIdempotentRequestError(error) ||
                    (error.response?.status ? error.response.status >= 500 : false);
            }
        });
        // Ensure raw directory exists
        if (this.config.rawDir && !fs.existsSync(this.config.rawDir)) {
            fs.mkdirSync(this.config.rawDir, { recursive: true });
        }
    }
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Fetch a URL and optionally save the raw HTML.
     * @param url The URL to fetch
     * @param saveAlias Optional alias (e.g., 'SMU_schedule') to use in filename. If not provided, derived from timestamp.
     */
    async get(url, saveAlias, config) {
        if (this.config.delayMs && this.config.delayMs > 0) {
            await this.sleep(this.config.delayMs);
        }
        try {
            console.log(`Fetching ${url}...`);
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
                console.log(`Saved raw HTML to ${filepath}`);
            }
            return html;
        }
        catch (error) {
            console.error(`Failed to fetch ${url}: ${error.message}`);
            throw error;
        }
    }
}
exports.Fetcher = Fetcher;
//# sourceMappingURL=fetcher.js.map