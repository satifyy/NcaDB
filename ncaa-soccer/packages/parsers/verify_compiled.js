
const { SidearmParser } = require('./dist/index');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('Running verify_compiled.js');
    const htmlPath = 'C:/Users/p0802/Documents/CS/NcaDB/ncaa-soccer/debug_live_duke.html';

    if (!fs.existsSync(htmlPath)) {
        console.error('HTML file not found:', htmlPath);
        return;
    }

    console.log(`Reading HTML from ${htmlPath}`);
    const html = fs.readFileSync(htmlPath, 'utf-8');

    const parser = new SidearmParser();
    console.log('Parsing schedule...');
    const games = await parser.parseSchedule(html, { debug: true, baseUrl: 'https://goduke.com' });

    console.log(`Parsed ${games.length} games.`);
    games.forEach(g => {
        console.log(`Key: ${g.dedupe_key} | Status: ${g.status} | Score: ${g.home_score}-${g.away_score}`);
    });
}

main().catch(console.error);
