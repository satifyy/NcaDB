
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const filePath = path.join(process.cwd(), 'debug_duke_schedule_clicked.html');
const content = fs.readFileSync(filePath, 'utf-8');
const $ = cheerio.load(content);

const links = $('a[href*="boxscore"]');
console.log(`Found ${links.length} links.`);

links.each((i, el) => {
    console.log(`Link ${i + 1}:`);
    console.log('Href:', $(el).attr('href'));
    console.log('Class:', $(el).attr('class'));
    console.log('Parent Tag:', $(el).parent().get(0).tagName);
    console.log('Parent Class:', $(el).parent().attr('class'));
    console.log('Closest div class:', $(el).closest('div').attr('class'));
    console.log('Closest ul class:', $(el).closest('ul').attr('class'));
});
