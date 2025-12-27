
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';

const htmlPath = path.resolve(__dirname, '../../../../data/raw/2025-12-27T07-14-57-340Z_UNC_schedule.html');
const debugPath = path.resolve(__dirname, 'debug_unc.txt');

const content = fs.readFileSync(htmlPath, 'utf-8');
const $ = cheerio.load(content);

const gameCards = $('.s-game-card');
let output = `Found ${gameCards.length} game cards.\n\n`;

if (gameCards.length > 0) {
    const firstCard = gameCards.first();

    output += '--- First Card HTML ---\n';
    output += firstCard.html() + '\n';
    output += '--- End HTML ---\n\n';

    output += '--- Text Content ---\n';
    output += firstCard.text().replace(/\s+/g, ' ') + '\n\n';

    // Check for specific commonly used classes
    const classes = new Set<string>();
    firstCard.find('*').each((_, el) => {
        const classVal = $(el).attr('class');
        if (classVal) {
            classVal.split(' ').forEach(c => classes.add(c));
        }
    });
    output += '--- Classes Found ---\n';
    output += Array.from(classes).join(', ') + '\n';
}

fs.writeFileSync(debugPath, output);
console.log(`Wrote debug info to ${debugPath}`);
