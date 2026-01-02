import fs from 'fs';
import path from 'path';

const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// Regex to capture the object inside window.__NUXT__=(...);
// It might be a function call or an object literal.
const match = html.match(/window\.__NUXT__=(.*?);/);

if (match && match[1]) {
    console.log('Found Nuxt object string.');
    let nuxtContent = match[1];

    // Sometimes it's wrapped in a function call, e.g., (function(a,b,...){...}(...));
    // or just a massive object.
    // Let's try to interpret it carefully.

    // For exploration, let's just save valid JSON candidates or the raw string.
    fs.writeFileSync('unc_nuxt_raw.js', nuxtContent);
    console.log('Saved raw Nuxt content to unc_nuxt_raw.js');
} else {
    console.log('Could not match window.__NUXT__ pattern.');
}
