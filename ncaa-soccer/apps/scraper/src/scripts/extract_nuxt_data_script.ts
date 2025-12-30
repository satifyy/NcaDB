import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const $ = cheerio.load(html);

let nuxtScript = '';
let found = false;
$('script').each((i: number, el: AnyNode) => {
    const content = $(el).html() || '';
    if (content.includes('Cordes') || content.includes('"boxscore"')) {
        nuxtScript = content;
        found = true;
        return false; // break
    }
});

if (found && nuxtScript) {
    fs.writeFileSync('nuxt_data_script.js', nuxtScript);
    console.log(`Extracted Nuxt data script. Length: ${nuxtScript.length}`);
    console.log('Start of script:', nuxtScript.substring(0, 200));
} else {
    console.error('Nuxt data script not found');
}
