
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const filePath = path.join(process.cwd(), 'debug_live_duke.html');
const content = fs.readFileSync(filePath, 'utf-8');
const $ = cheerio.load(content);

console.log('Scanning for script tags with JSON...');

$('script').each((i, el) => {
    const html = $(el).html();
    if (!html) return;

    if (html.includes('"schedule":')) {
        console.log(`\n--- Found "schedule" in Script ${i} ---`);
        const idx = html.indexOf('"schedule":');
        console.log(html.substring(Math.max(0, idx - 100), Math.min(html.length, idx + 200)));

        // Try to extract full object if it assigns to a variable
        const match = html.match(/var\s+\w+\s*=\s*({.*});/s) || html.match(/window\.\w+\s*=\s*({.*});/s) || html.match(/obj\s*=\s*({.*});/s);
        if (match) {
            const json = match[1];
            const filename = `debug_script_${i}.json`;
            fs.writeFileSync(filename, json);
            console.log(`Saved JSON candidate to ${filename}`);
        } else {
            console.log('Could not extract clean JSON object from this script.');
            // Save raw content for manual inspection
            fs.writeFileSync(`debug_script_${i}_raw.js`, html);
            console.log(`Saved raw script to debug_script_${i}_raw.js`);
        }
    }
});
