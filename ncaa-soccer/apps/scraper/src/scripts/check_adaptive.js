const axios = require('axios');

const url = 'https://goheels.com/services/adaptive_components.ashx?type=boxscore&id=26235';

async function main() {
    try {
        console.log(`Fetching ${url}...`);
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        console.log(`Status: ${res.status}`);
        if (typeof res.data === 'object') {
            console.log('Keys:', Object.keys(res.data));
            // Sidearm adaptive usually puts data in 'content' or 'data'.
            // Sometimes it returns HTML inside JSON??
            console.log('Sample:', JSON.stringify(res.data).substring(0, 500));
        }
    } catch (e) {
        console.log(`Failed: ${e.message}`);
    }
}

main();
