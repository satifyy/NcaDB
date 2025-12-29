"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const fs_1 = __importDefault(require("fs"));
async function main() {
    // A sample boxscore URL from games.csv
    const url = 'https://goheels.com/sports/mens-soccer/stats/2025/ucf/boxscore/26235';
    console.log(`Fetching ${url}...`);
    try {
        const response = await axios_1.default.get(url, {
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
        fs_1.default.writeFileSync('unc_boxscore_page.html', html);
        // Check for common data sources
        const nuxtMatch = html.match(/window\.__NUXT__=(.*?);/);
        if (nuxtMatch) {
            console.log('Found window.__NUXT__');
            // console.log(nuxtMatch[1].substring(0, 200));
        }
        else {
            console.log('No window.__NUXT__ found');
        }
        // Check for tables
        if (html.includes('<table')) {
            console.log('Found generic <table> tag');
        }
        if (html.includes('sidearm-table')) {
            console.log('Found sidearm-table class');
        }
    }
    catch (error) {
        console.error('Fetch failed:', error.message);
    }
}
main();
//# sourceMappingURL=verify_boxscore_fetch.js.map