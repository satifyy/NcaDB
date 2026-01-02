const axios = require('axios');

const gameId = '26235';
const baseUrl = 'https://goheels.com';
const boxscoreUrl = 'https://goheels.com/sports/mens-soccer/stats/2025/ucf/boxscore/26235';

const urls = [
    `${baseUrl}/api/v1/stats/game/${gameId}`,
    `${baseUrl}/xml/sidearm/stats/boxscore/${gameId}.xml`,
    `${baseUrl}/boxscore.aspx?id=${gameId}&xml=true`
];

async function checkUrl(url) {
    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json, text/xml, */*'
            },
            timeout: 5000,
            validateStatus: () => true // Resolve all statuses
        });
        const contentType = res.headers['content-type'] || 'unknown';
        const len = res.data ? (typeof res.data === 'string' ? res.data.length : JSON.stringify(res.data).length) : 0;
        console.log(`[${res.status}] ${url.substring(0, 60)}... (${contentType}) Len: ${len}`);
        // if (res.status === 200) console.log(JSON.stringify(res.data).substring(0, 100));
    } catch (e) {
        console.log(`[ERR] ${url.substring(0, 60)}... : ${e.message}`);
    }
}

async function main() {
    for (const url of urls) {
        await checkUrl(url);
    }
}

main();
