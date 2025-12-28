const fs = require('fs');
const path = require('path');

const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const index = html.indexOf('sidearm-table');
if (index !== -1) {
    console.log(`Found 'sidearm-table' at index ${index}`);
    console.log('--- Context ---');
    console.log(html.substring(Math.max(0, index - 200), index + 200));
} else {
    console.log("'sidearm-table' NOT found in file.");
}
