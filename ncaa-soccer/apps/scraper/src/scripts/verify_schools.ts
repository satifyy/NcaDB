
import { accSchools } from '../config/schools';
import { Fetcher } from '../utils/fetcher';

async function main() {
    console.log('Verifying ACC School APIs...');
    const fetcher = new Fetcher({ delayMs: 1000, quiet: true }); // Polite delay, quiet mode

    for (const school of accSchools) {
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
                } else {
                    console.warn(`[WARN] ${school.name}: Not an array`);
                }
            } catch (e) {
                console.error(`[ERR] ${school.name}: Invalid JSON`);
            }
        } catch (e: any) {
            console.error(`[ERR] ${school.name}: Fetch failed`);
        }
    }
}

main();
