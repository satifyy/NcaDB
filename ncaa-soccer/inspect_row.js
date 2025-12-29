
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const filePath = path.join(process.cwd(), 'debug_live_duke.html');
const content = fs.readFileSync(filePath, 'utf-8');
const $ = cheerio.load(content);

const rows = $('.s-table-body__row');
console.log(`Found ${rows.length} rows.`);

if (rows.length > 0) {
    const row = rows.first();
    console.log('Row HTML structure (simplified):');
    row.children().each((i, el) => {
        const child = $(el);
        console.log(`Child ${i}: Tag=${el.tagName}, Class="${child.attr('class')}", Text="${child.text().trim().substring(0, 50)}..."`);
    });

    // Check for specific fields
    console.log('\nPotential Date:', row.find('.s-text-paragraph-bold').first().text().trim());
    console.log('Potential Opponent:', row.find('.sidearm-schedule-game-opponent-name').text().trim());
    console.log('Potential Score:', row.find('.sidearm-schedule-game-result').text().trim());

    // Check deep text
    console.log('\nDeep Text Dump:');
    console.log(row.text().replace(/\s+/g, ' ').trim().substring(0, 200));
}
