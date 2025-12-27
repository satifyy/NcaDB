
import * as fs from 'fs';
import * as path from 'path';
import { SidearmParser } from '@ncaa/parsers';
import { GameStorageAdapter } from '@ncaa/storage';

async function main() {
    console.log('Verifying UNC Schedule Parser (HTML)...');

    const htmlPath = path.resolve(__dirname, '../../../../data/raw/2025-12-27T07-14-57-340Z_UNC_schedule.html');

    if (!fs.existsSync(htmlPath)) {
        console.error(`File not found: ${htmlPath}`);
        process.exit(1);
    }

    const content = fs.readFileSync(htmlPath, 'utf-8');
    const parser = new SidearmParser();

    console.log(`Parsing content from ${htmlPath}...`);
    try {
        const games = await parser.parseSchedule(content, { teamName: 'UNC' });
        console.log(`Successfully parsed ${games.length} games.`);

        if (games.length > 0) {
            console.log('Sample games:');
            games.slice(0, 5).forEach(g => {
                const score = (g.home_score !== null && g.away_score !== null)
                    ? `(${g.home_score}-${g.away_score})`
                    : '';
                console.log(`[${g.date}] ${g.home_team_name} vs ${g.away_team_name} ${score} [${g.location_type}] Status: ${g.status}`);
            });

            // Storage Verification
            const storageDir = path.resolve(__dirname, '../../../../data');
            const storage = new GameStorageAdapter(storageDir);
            console.log(`Saving games to ${storageDir}/games/2025/games.csv ...`);
            await storage.saveGames(games, '2025');
        }
    } catch (e: any) {
        console.error('Parsing failed:', e);
    }
}

main();
