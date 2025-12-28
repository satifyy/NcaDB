import * as path from 'path';
import { Fetcher } from '../utils/fetcher';
import { SidearmParser } from '@ncaa/parsers';
import { GameStorageAdapter } from '@ncaa/storage';

async function main() {
    const [, , url, teamName = 'Unknown Team', alias = 'schedule'] = process.argv;

    if (!url) {
        console.error('Usage: ts-node fetch_schedule.ts <url> <teamName> [alias]');
        process.exit(1);
    }

    const fetcher = new Fetcher({
        rawDir: path.resolve(__dirname, '../../../../data/raw'),
        delayMs: 0
    });

    console.log(`Fetching schedule from ${url}...`);
    const html = await fetcher.get(url, alias);

    const parser = new SidearmParser();
    const games = await parser.parseSchedule(html, { teamName });
    console.log(`Parsed ${games.length} games for ${teamName}.`);

    games.forEach(g => {
        const score = (g.home_score ?? '-') + '-' + (g.away_score ?? '-');
        console.log(`${g.date}: ${g.home_team_name} vs ${g.away_team_name} ${score} status=${g.status}`);
    });

    if (games.length > 0) {
        const year = games[0].date.split('-')[0];
        const storageDir = path.resolve(__dirname, '../../../../data');
        const storage = new GameStorageAdapter(storageDir);
        await storage.saveGames(games, year);
        console.log(`Saved games to ${path.join(storageDir, 'games', year, 'games.csv')}`);
    }
}

main().catch(err => {
    console.error('fetch_schedule failed:', err);
    process.exit(1);
});
