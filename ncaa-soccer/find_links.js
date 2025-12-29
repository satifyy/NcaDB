
const fs = require('fs');
const path = require('path');

const filePath = path.join(process.cwd(), 'debug_duke_schedule_clicked.html');
const content = fs.readFileSync(filePath, 'utf-8');

const regex = /<a[^>]*href=["'][^"']*boxscore[^"']*["'][^>]*>/gi;
const matches = content.match(regex);

if (matches) {
    console.log(`Found ${matches.length} matches:`);
    matches.forEach((m, i) => console.log(`${i + 1}: ${m}`));
} else {
    console.log('No matches found.');
}
