import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const $ = cheerio.load(html);

console.log('--- Tables Analysis ---');
const tables = $('table');
console.log(`Found ${tables.length} tables.`);

tables.each((i, table) => {
    const className = $(table).attr('class');
    const rowCount = $(table).find('tr').length;
    console.log(`Table ${i}: class="${className}" Rows: ${rowCount}`);

    // Print first row text
    const firstRow = $(table).find('tr').first().text().replace(/\s+/g, ' ').trim().substring(0, 100);
    console.log(`  First Row: ${firstRow}`);
});

console.log('\n--- Script Analysis ---');
const scripts = $('script');
scripts.each((i, script) => {
    const content = $(script).html() || '';
    if (content.includes('window.__NUXT__')) {
        console.log(`Found window.__NUXT__ in script ${i}. Length: ${content.length}`);
        const start = content.indexOf('window.__NUXT__=');
        console.log('  Snippet:', content.substring(start, start + 200));
    }
});
