const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const axios = require('axios');
import type { AnyNode } from 'domhandler';

async function main() {
    const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const $ = cheerio.load(html);

    console.log('--- Links ---');
    $('link').each((i: number, el: AnyNode) => {
        const href = $(el).attr('href');
        if (href && (href.includes('_nuxt') || href.includes('json') || href.includes('payload'))) {
            console.log(`Link: ${href}`);
        }
    });

    console.log('\n--- Scripts ---');
    $('script').each((i: number, el: AnyNode) => {
        const src = $(el).attr('src');
        if (src && (src.includes('_nuxt') || src.includes('json'))) {
            console.log(`Script: ${src}`);
        }
    });

    // Try to fetch the meta json if found
    const metaLink = $('link[href*="meta"][href*="json"]').attr('href');
    if (metaLink) {
        console.log(`\nFetching meta: ${metaLink}`);
        try {
            const url = `https://goheels.com${metaLink}`;
            const res = await axios.get(url);
            console.log('Meta JSON keys:', Object.keys(res.data));
        } catch (e) {
            if (e instanceof Error) {
                console.error('Fetch failed:', e.message);
            } else {
                console.error('Fetch failed:', e);
            }
        }
    }
}

main();
