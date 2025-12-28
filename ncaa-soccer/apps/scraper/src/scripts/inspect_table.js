const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const rawFilename = '2025-12-28T20-39-02-665Z_boxscore_2025-08-24-UNC-Seattle.html';
const htmlPath = path.join(process.cwd(), 'data/raw', rawFilename);
const html = fs.readFileSync(htmlPath, 'utf8');
const $ = cheerio.load(html);

console.log('--- Analyzing Tables (Deep Scan) ---');
$('table').each((i, table) => {
    const rows = $(table).find('tbody tr');
    let hasEight = false;
    rows.each((x, row) => {
        const cols = $(row).find('td');
        if (cols.length >= 8) {
            hasEight = true;
            console.log(`Table ${i} Row ${x} has ${cols.length} cols.`);
            cols.each((j, td) => {
                console.log(`    Col ${j}: "${$(td).text().trim().substring(0, 30)}"`);
            });
        }
    });
    if (hasEight) {
        console.log(`Table ${i} matches parsing criteria!`);
    }
});
