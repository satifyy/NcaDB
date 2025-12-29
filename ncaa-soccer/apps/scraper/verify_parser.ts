
import { SidearmParser } from '../../packages/parsers/src/index';
import fs from 'fs';
import path from 'path';

async function main() {
    console.log('Sanity check: Running modified verify parser');
    const htmlPath = path.resolve('../../debug_live_duke.html');
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
