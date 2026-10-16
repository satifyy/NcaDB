import * as fs from 'fs';
import * as path from 'path';
import { SidearmParser, SidearmBoxScoreParser } from '@ncaa/parsers';
import { BOXSCORE_CAPTURE_VERSION } from '@ncaa/shared';
import { PLAYER_STAT_CSV_COLUMNS, RAW_DIR, playerStatsCsv } from '@ncaa/storage';
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
    position: string | null;
    started: number | null;
    goals_allowed: number | null;
    capture_version: number;
}

async function main() {
    const [, , scheduleUrl, teamName = 'Unknown Team', alias = 'schedule_for_boxscores'] = process.argv;

    if (!scheduleUrl) {
        console.error('Usage: ts-node fetch_boxscores.ts <scheduleUrl> <teamName> [alias]');
        process.exit(1);
    }

    const fetcher = new Fetcher({
        rawDir: RAW_DIR,
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
                    shots_on_goal: toNumberOrNull(p.stats?.shots_on_goal),
                    saves: toNumberOrNull(p.stats?.saves),
                    position: String(p.stats?.position ?? '').trim() || null,
                    started: toNumberOrNull(p.stats?.started),
                    goals_allowed: toNumberOrNull(p.stats?.goals_allowed),
                    capture_version: BOXSCORE_CAPTURE_VERSION
                });
            });
            console.log(`Parsed ${res.playerStats.length} player rows`);
        } catch (e: any) {
            console.error(`Failed ${boxUrl}: ${e.message}`);
        }
    }

    const year = games[0]?.date?.split('-')[0] || 'unknown';
    const csvPath = playerStatsCsv(year);
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });

    const header = PLAYER_STAT_CSV_COLUMNS;
    const lines = [header.join(',')];
    rows.forEach(r => {
        const record = r as unknown as Record<string, unknown>;
        lines.push(header.map(column => escapeCsv(String(record[column] ?? ''))).join(','));
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

function toNumberOrNull(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    const num = Number(value);
    return Number.isNaN(num) ? null : num;
}

main().catch(err => {
    console.error('fetch_boxscores failed:', err);
    process.exit(1);
});
