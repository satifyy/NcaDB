const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('c:\\Users\\p0802\\Documents\\CS\\NcaDB-1\\ncaa-soccer\\data\\raw\\2025-12-29T04-12-22-139Z_SMU_schedule.html', 'utf-8');
const $ = cheerio.load(html);

console.log('Year indicators:');
// Check headers
$('h1, h2, h3').each((i, el) => {
    const text = $(el).text().trim();
    if (text.includes('2025') || text.includes('2024') || text.includes('Schedule')) {
        console.log(`  ${$(el).prop('tagName')}: ${text}`);
    }
});

// Check section attributes
const gameSection = $('.sidearm-schedule-game').first().closest('section');
console.log('\nSection classes:', gameSection.attr('class'));
console.log('Section data-season:', gameSection.attr('data-season'));

// Check parent container
const container = $('.sidearm-schedule-games-container');
console.log('Container data attrs:', container.get(0) ? container.get(0).attribs : 'none');

console.log('\nFirst game date text:', $('.sidearm-schedule-game').first().find('.sidearm-schedule-game-opponent-date span').first().text().trim());
