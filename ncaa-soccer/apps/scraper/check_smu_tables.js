const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('c:\\Users\\p0802\\Documents\\CS\\NcaDB-1\\ncaa-soccer\\data\\raw\\2025-12-29T04-12-22-139Z_SMU_schedule.html', 'utf-8');
const $ = cheerio.load(html);

console.log('Container analysis:');
const gameRow = $('.sidearm-schedule-game').first();
console.log('First game row class:', gameRow.attr('class'));
console.log('Parent:', gameRow.parent().prop('tagName'), gameRow.parent().attr('class'));
console.log('Grandparent:', gameRow.parent().parent().prop('tagName'), gameRow.parent().parent().attr('class'));

console.log('\nAll .sidearm-schedule-game rows:', $('.sidearm-schedule-game').length);
console.log('Ul structure:', $('ul.sidearm-schedule-game').length);
console.log('.sidearm-schedule-games-container:', $('.sidearm-schedule-games-container').length);
console.log('.sidearm-schedule-games-container > li:', $('.sidearm-schedule-games-container > li').length);

// Check the HTML structure
console.log('\nFirst game row structure:');
const firstGame = $('.sidearm-schedule-game').first();
console.log('Tag:', firstGame.prop('tagName'));
console.log('Children count:', firstGame.children().length);
console.log('First child:', firstGame.children().first().attr('class'));
