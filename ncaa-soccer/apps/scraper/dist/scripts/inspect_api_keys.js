"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const schools_1 = require("../config/schools");
const fetcher_1 = require("../utils/fetcher");
async function main() {
    const fetcher = new fetcher_1.Fetcher({ delayMs: 1000, quiet: true });
    const school = schools_1.accSchools[0];
    try {
        const response = await fetcher.get(school.scheduleApiUrl, undefined, {
            headers: { 'Referer': school.baseUrl, 'X-Requested-With': 'XMLHttpRequest' }
        });
        const data = JSON.parse(response);
        if (Array.isArray(data) && data.length > 0) {
            console.log('--- ALL KEYS ---');
            Object.keys(data[0]).forEach(k => console.log(k));
        }
    }
    catch (e) {
        console.error(e);
    }
}
main();
//# sourceMappingURL=inspect_api_keys.js.map