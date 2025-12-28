const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const $ = cheerio.load(html);

$('script').each((i, el) => {
    const content = $(el).html() || '';
    if (content.includes('Cordes')) {
        console.log(`Found Cordes in script index ${i}`);
        console.log('Attributes:', $(el).attr());
        console.log('Start of content:', content.substring(0, 100));
        return false;
    }
});
