import fs from 'fs';
import path from 'path';

const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const regex = /window\.__NUXT__\.([a-zA-Z0-9_$]+)\s*=/g;
let match;

while ((match = regex.exec(html)) !== null) {
    console.log(`Found assignment to window.__NUXT__.${match[1]} at index ${match.index}`);
    // Print a bit of what follows to see if it looks like data
    console.log(html.substring(match.index, match.index + 100));
}
