
import * as fs from 'fs';
import * as path from 'path';
import { Game } from '@ncaa/shared';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

export class GameStorageAdapter {
    private baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = baseDir;
    }

    async saveGames(games: Game[], season: string): Promise<void> {
        if (games.length === 0) return;

        const dir = path.join(this.baseDir, 'games', season);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const filePath = path.join(dir, 'games.csv');
        const headers = [
            'game_id', 'date', 'home_team_name', 'away_team_name',
            'home_score', 'away_score', 'location_type', 'status',
            'schedule_url', 'boxscore_url', 'dedupe_key'
        ];

        const gamesMap = new Map<string, any>();

        // 1. Read existing
        if (fs.existsSync(filePath)) {
            try {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const records: any[] = parse(fileContent, {
                    columns: true,
                    skip_empty_lines: true
                });

                for (const record of records) {
                    // Normalize dedupe_key just in case
                    if (record.dedupe_key) {
                        gamesMap.set(record.dedupe_key, record);
                    }
                }
            } catch (e) {
                console.warn(`Error reading existing CSV at ${filePath}:`, e);
            }
        }

        // 2. Upsert new games
        for (const game of games) {
            // Flatten game object to match CSV structure
            const row = {
                game_id: game.game_id,
                date: game.date,
                home_team_name: game.home_team_name,
                away_team_name: game.away_team_name,
                home_score: game.home_score !== null ? String(game.home_score) : '',
                away_score: game.away_score !== null ? String(game.away_score) : '',
                location_type: game.location_type,
                status: game.status,
                schedule_url: game.source_urls?.schedule_url || '',
                boxscore_url: game.source_urls?.boxscore_url || '',
                dedupe_key: game.dedupe_key
            };

            gamesMap.set(game.dedupe_key, row);
        }

        // 3. Write back
        const allGames = Array.from(gamesMap.values());

        // ensure sorting by date
        allGames.sort((a, b) => a.date.localeCompare(b.date));

        const output = stringify(allGames, {
            header: true,
            columns: headers
        });

        fs.writeFileSync(filePath, output);
        console.log(`Saved ${games.length} games (merged with existing) to ${filePath}`);
    }
}
