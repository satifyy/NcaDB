import fs from 'fs';
import path from 'path';
import { SidearmBoxScoreParser } from '../../../../packages/parsers/src';

const rawFilename = '2025-12-28T20-39-02-665Z_boxscore_2025-08-24-UNC-Seattle.html';
const htmlPath = path.join(process.cwd(), 'data/raw', rawFilename);

if (!fs.existsSync(htmlPath)) {
    console.error(`File not found: ${htmlPath}`);
    process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');

const parser = new SidearmBoxScoreParser();
const result = parser.parse(html, { sourceUrl: 'https://test.com' });

console.log(`Parsed ${result.playerStats.length} stats.`);

if (result.playerStats.length > 0) {
    console.log('Sample Stats:');
    result.playerStats.slice(0, 5).forEach(stat => {
        console.log(`${stat.team_id} - ${stat.jersey_number} ${stat.player_name}: ${stat.minutes} min`);
    });
}
