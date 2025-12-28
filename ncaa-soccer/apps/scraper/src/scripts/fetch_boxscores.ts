import * as fs from 'fs';
import * as path from 'path';
import { SidearmParser, SidearmBoxScoreParser } from '@ncaa/parsers';
import { Fetcher } from '../utils/fetcher';

interface PlayerRow {
    game_id: string;
    team_id: string;
    player_name: string;
    player_key: string;
    jersey_number: string | null;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    shots: number | null;
    shots_on_goal: number | null;
    saves: number | null;
}

async function main() {
    const [, , scheduleUrl, teamName = 'Unknown Team', alias = 'schedule_for_boxscores'] = process.argv;

    if (!scheduleUrl) {
        console.error('Usage: ts-node fetch_boxscores.ts <scheduleUrl> <teamName> [alias]');
        process.exit(1);
    }

    const fetcher = new Fetcher({
        rawDir: path.resolve(__dirname, '../../../../data/raw'),
        delayMs: 0
    });

    console.log(`Fetching schedule ${scheduleUrl}...`);
    const scheduleHtml = await fetcher.get(scheduleUrl, alias);

    const scheduleParser = new SidearmParser();
    const games = await scheduleParser.parseSchedule(scheduleHtml, { teamName, baseUrl: scheduleUrl, debug: true });

    console.log(`Found ${games.length} games. Collecting boxscore URLs...`);
    const targets = games.filter(g => g.source_urls?.boxscore_url).map(g => ({
        game: g,
        boxUrl: g.source_urls!.boxscore_url as string
    }));

    console.log(`Boxscore targets: ${targets.length}`);
    const boxParser = new SidearmBoxScoreParser();
    const rows: PlayerRow[] = [];

    for (const { game, boxUrl } of targets) {
        console.log(`Fetching boxscore ${boxUrl} for ${game.date} ${game.home_team_name} vs ${game.away_team_name}`);
        try {
            const html = await fetcher.get(boxUrl, `boxscore_${game.dedupe_key}`);
            const res = boxParser.parse(html, { sourceUrl: boxUrl });
            res.playerStats.forEach(p => {
                rows.push({
                    game_id: game.game_id,
                    team_id: p.team_id,
                    player_name: p.player_name,
                    player_key: p.player_key,
                    jersey_number: p.jersey_number ?? null,
                    minutes: p.minutes ?? null,
                    goals: (p as any).goals ?? null,
                    assists: (p as any).assists ?? null,
                    shots: (p as any).shots ?? null,
                    shots_on_goal: p.stats?.shots_on_goal ?? null,
                    saves: p.stats?.saves ?? null
                });
            });
            console.log(`Parsed ${res.playerStats.length} player rows`);
        } catch (e: any) {
            console.error(`Failed ${boxUrl}: ${e.message}`);
        }
    }

    const year = games[0]?.date?.split('-')[0] || 'unknown';
    const statsDir = path.resolve(__dirname, '../../../../data/player_stats', year);
    fs.mkdirSync(statsDir, { recursive: true });
    const csvPath = path.join(statsDir, 'player_stats.csv');

    const header = [
        'game_id', 'team_id', 'player_name', 'player_key', 'jersey_number',
        'minutes', 'goals', 'assists', 'shots', 'shots_on_goal', 'saves'
    ];

    const lines = [header.join(',')];
    rows.forEach(r => {
        const vals = [
            r.game_id,
            r.team_id,
            r.player_name,
            r.player_key,
            r.jersey_number ?? '',
            r.minutes ?? '',
            r.goals ?? '',
            r.assists ?? '',
            r.shots ?? '',
            r.shots_on_goal ?? '',
            r.saves ?? ''
        ];
        lines.push(vals.map(v => escapeCsv(String(v))).join(','));
    });

    fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
    console.log(`Wrote ${rows.length} player rows to ${csvPath}`);
}

function escapeCsv(field: string): string {
    if (field === undefined || field === null) return '';
    if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        return `"${field.replace(/"/g, '""')}"`;
    }
    return field;
}

main().catch(err => {
    console.error('fetch_boxscores failed:', err);
    process.exit(1);
});
