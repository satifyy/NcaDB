import { Fetcher } from '../utils/fetcher';
import * as path from 'path';

async function main() {
    console.log("Starting Fetcher test...");

    // Initialize fetcher with a visible raw directory for testing
    // Using default data/raw in root
    const fetcher = new Fetcher({
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
        } catch (error: any) {
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
