const fs = require('fs');
const path = require('path');

const htmlPath = path.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const index = html.indexOf('Cordes');
if (index !== -1) {
    console.log(`Found 'Cordes' at index ${index}`);
    console.log('--- Context ---');
    console.log(html.substring(Math.max(0, index - 200), index + 200));

    // Check if inside a script tag
    const scriptStart = html.lastIndexOf('<script', index);
    const scriptEnd = html.indexOf('</script>', index);

    if (scriptStart !== -1 && scriptEnd !== -1 && scriptEnd > index) {
        console.log(`It appears to be inside a script tag starting at ${scriptStart} (len: ${scriptEnd - scriptStart})`);
    } else {
        console.log('Does NOT appear to be inside a standard script tag (or logic failed).');
    }
}
