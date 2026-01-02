import fs from 'fs';
import path from 'path';

const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const index = html.indexOf('window.__NUXT__');
if (index !== -1) {
    console.log(`Found window.__NUXT__ at index ${index}`);
    console.log('--- Context start ---');
    console.log(html.substring(index, index + 10000));
    console.log('--- Context end ---');
} else {
    console.log('window.__NUXT__ NOT found');
}
