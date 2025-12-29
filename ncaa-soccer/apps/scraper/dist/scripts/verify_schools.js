"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const schools_1 = require("../config/schools");
const fetcher_1 = require("../utils/fetcher");
async function main() {
    console.log('Verifying ACC School APIs...');
    const fetcher = new fetcher_1.Fetcher({ delayMs: 1000, quiet: true }); // Polite delay, quiet mode
    for (const school of schools_1.accSchools) {
        console.log(`Checking ${school.name} (${school.scheduleApiUrl})...`);
        try {
            const response = await fetcher.get(school.scheduleApiUrl, undefined, {
                headers: {
                    'Referer': school.baseUrl,
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            try {
                const data = JSON.parse(response);
                if (Array.isArray(data)) {
                    console.log(`[OK] ${school.name}: ${data.length} games`);
                }
                else {
                    console.warn(`[WARN] ${school.name}: Not an array`);
                }
            }
            catch (e) {
                console.error(`[ERR] ${school.name}: Invalid JSON`);
            }
        }
        catch (e) {
            console.error(`[ERR] ${school.name}: Fetch failed`);
        }
    }
}
main();
//# sourceMappingURL=verify_schools.js.map