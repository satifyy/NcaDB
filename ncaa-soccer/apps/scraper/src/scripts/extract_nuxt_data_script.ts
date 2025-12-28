import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const $ = cheerio.load(html);

let nuxtScript = null;
$('script').each((i, el) => {
    const content = $(el).html() || '';
    if (content.includes('Cordes') || content.includes('"boxscore"')) {
        nuxtScript = content;
        return false; // break
    }
});

if (nuxtScript) {
    fs.writeFileSync('nuxt_data_script.js', nuxtScript);
    console.log(`Extracted Nuxt data script. Length: ${nuxtScript.length}`);
    console.log('Start of script:', nuxtScript.substring(0, 200));
} else {
    console.error('Nuxt data script not found');
}
