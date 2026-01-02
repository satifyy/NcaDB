const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Adjust filename as needed
const rawFilename = '2025-12-28T20-39-02-665Z_boxscore_2025-08-24-UNC-Seattle.html';
const htmlPath = path.join(process.cwd(), 'data/raw', rawFilename); // Correct path

if (!fs.existsSync(htmlPath)) {
    console.error(`File not found: ${htmlPath}`);
    process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const $ = cheerio.load(html);

// Extract Nuxt script
const scriptContent = $('#__NUXT_DATA__').html();
if (!scriptContent) {
    console.error('No __NUXT_DATA__ found');
    process.exit(1);
}

const data = JSON.parse(scriptContent);
console.log(`Parsed Nuxt Data. Array len: ${data.length}`);

// Helper to resolve
const resolve = (val) => {
    if (typeof val === 'number' && val < data.length) return resolve(data[val]);
    return val;
};

// Find Muñoz
let targetIndex = -1;
for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (typeof item === 'string' && item.includes('Muñoz') && !item.includes('<')) {
        console.log(`Found 'Muñoz' at index ${i}: "${item}"`);
        targetIndex = i;
        break;
    }
}

if (targetIndex !== -1) {
    // Find player object referencing Muñoz
    for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (typeof item === 'object' && item !== null) {
            Object.values(item).forEach(val => {
                if (val === targetIndex) {
                    console.log(`\nLikely Player Object at index ${i}:`);
                    console.log(JSON.stringify(item, null, 2));

                    // Resolve its keys
                    console.log('\nResolved values:');
                    Object.keys(item).forEach(k => {
                        const v = item[k];
                        console.log(`${k}: ${v} -> ${resolve(v)}`);
                    });
                }
            });
        }
    }
}
