
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const filePath = path.join(process.cwd(), 'debug_duke_schedule_clicked.html');
const content = fs.readFileSync(filePath, 'utf-8');
const $ = cheerio.load(content);

const rows = $('.s-table-body__row');
if (rows.length > 0) {
    const row = rows.first();
    const cells = row.find('td');
    console.log(`Row has ${cells.length} cells.`);
    cells.each((i, el) => {
        console.log(`Cell ${i}: "${$(el).text().replace(/\s+/g, ' ').trim()}"`);
    });
} else {
    console.log('No rows found.');
}
