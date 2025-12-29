
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const filePath = path.join(process.cwd(), 'debug_duke_schedule_clicked.html');
const content = fs.readFileSync(filePath, 'utf-8');
const $ = cheerio.load(content);

const links = $('a[href*="boxscore"]');
if (links.length > 0) {
    const el = links.first();
    console.log('Href: ' + el.attr('href'));
    console.log('Div Class: ' + el.closest('div').attr('class'));
    console.log('Parent Class: ' + el.parent().attr('class'));
    console.log('Grandparent Class: ' + el.parent().parent().attr('class'));
}
