import { accSchools } from '../config/schools';
import { Fetcher } from '../utils/fetcher';

async function main() {
    const fetcher = new Fetcher({ delayMs: 1000, quiet: true });
    const school = accSchools[0];

    try {
        const response = await fetcher.get(school.scheduleApiUrl, undefined, {
            headers: { 'Referer': school.baseUrl, 'X-Requested-With': 'XMLHttpRequest' }
        });
        const data = JSON.parse(response);
        if (Array.isArray(data) && data.length > 0) {
            console.log('--- ALL KEYS ---');
            Object.keys(data[0]).forEach(k => console.log(k));
        }
    } catch (e) { console.error(e); }
}

main();
