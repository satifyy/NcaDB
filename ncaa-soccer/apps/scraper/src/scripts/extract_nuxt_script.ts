import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const $ = cheerio.load(html);

let nuxtScript = null;
$('script').each((i, el) => {
    const content = $(el).html() || '';
    if (content.includes('window.__NUXT__')) {
        nuxtScript = content;
        return false; // break
    }
});

if (nuxtScript) {
    fs.writeFileSync('nuxt_script.js', nuxtScript);
    console.log('Extracted Nuxt script to nuxt_script.js');
} else {
    console.error('Nuxt script not found');
}
