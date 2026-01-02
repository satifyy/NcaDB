
import axios from 'axios';
import fs from 'fs';

async function main() {
    const url = 'https://goheels.com/sports/mens-soccer/schedule/2024';
    console.log(`Fetching ${url}...`);

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            },
            timeout: 10000
        });

        const html = response.data;
        console.log(`Status: ${response.status}`);
        console.log(`Length: ${html.length}`);

        // Write to file for inspection
        fs.writeFileSync('unc_schedule_page.html', html);

        // Check for NUXT
        if (html.includes('window.__NUXT__')) {
            console.log('Found window.__NUXT__!');

            // Simple extraction attempt
            // Usually valid JS: window.__NUXT__=(...);
            const regex = /window\.__NUXT__=(.*?);/;
            const match = html.match(regex);
            if (match && match[1]) {
                console.log('Extracted NUXT object string (first 100 chars):', match[1].substring(0, 100));
                // Try parse? It might be JS object literal, not JSON, or a function call
                // Often it is: window.__NUXT__=(function(a,b,...){...}(...)); which is hard to parse without eval
                // Or standard JSON if lucky.
            } else {
                console.log('Could not regex match the NUXT assignment.');
            }
        } else {
            console.log('Did NOT find window.__NUXT__ in HTML.');
        }

    } catch (error: any) {
        console.error('Fetch failed:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
        }
    }
}

main();
