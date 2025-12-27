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
Object.defineProperty(exports, "__esModule", { value: true });
const fetcher_1 = require("../utils/fetcher");
const path = __importStar(require("path"));
async function main() {
    console.log("Starting Fetcher test...");
    // Initialize fetcher with a visible raw directory for testing
    // Using default data/raw in root
    const fetcher = new fetcher_1.Fetcher({
        delayMs: 2000,
        timeout: 30000, // Increased to 30s
        rawDir: path.resolve(__dirname, '../../../../data/raw')
    });
    // Test SMU JSON endpoints
    const urls = [
        'https://smumustangs.com/services/adaptive_components.ashx?type=results&sport_id=8&count=50',
        'https://smumustangs.com/services/adaptive_components.ashx?type=events&sport_id=8&count=50'
    ];
    for (const url of urls) {
        console.log(`\n--- Processing ${url} ---`);
        try {
            // Use a specific alias for the JSON files
            const alias = url.includes('results') ? 'SMU_results_json' : 'SMU_events_json';
            const html = await fetcher.get(url, alias, {
                headers: {
                    'Referer': 'https://smumustangs.com/sports/mens-soccer/schedule/2025',
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            console.log(`Successfully fetched ${url}`);
            console.log(`Content preview: ${html.substring(0, 200)}`);
        }
        catch (error) {
            console.error(`FAILURE: Could not fetch ${url}: ${error.message}`);
            process.exit(1);
        }
    }
    console.log("\nAll targets fetched successfully.");
}
main().catch(err => {
    console.error("Script failed:", err);
    process.exit(1);
});
//# sourceMappingURL=test_fetch.js.map