
import * as fs from 'fs';
import * as path from 'path';
import { Game } from '@ncaa/shared';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

export class GameStorageAdapter {
    private baseDir: string;
    private verbose: boolean;

    constructor(baseDir: string, options?: { verbose?: boolean }) {
        this.baseDir = baseDir;
        this.verbose = options?.verbose || false;
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
            'home_team_ranked', 'away_team_ranked',
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

        // 2. Upsert new games with smart merging
        for (const game of games) {
            // Flatten game object to match CSV structure
            const row = {
                game_id: game.game_id,
                date: game.date,
                home_team_name: game.home_team_name,
                away_team_name: game.away_team_name,
                home_team_ranked: game.home_team_ranked ? 'true' : 'false',
                away_team_ranked: game.away_team_ranked ? 'true' : 'false',
                home_score: game.home_score !== null ? String(game.home_score) : '',
                away_score: game.away_score !== null ? String(game.away_score) : '',
                location_type: game.location_type,
                status: game.status,
                schedule_url: game.source_urls?.schedule_url || '',
                boxscore_url: game.source_urls?.boxscore_url || '',
                dedupe_key: game.dedupe_key
            };

            // Smart merge: if game already exists, update with better data
            const existing = gamesMap.get(game.dedupe_key);
            if (existing) {
                if (this.verbose) {
                    console.log(`🔄 Duplicate detected: ${game.dedupe_key}`);
                }
                
                // Prefer known location_type over "unknown"
                if (existing.location_type === 'unknown' && row.location_type !== 'unknown') {
                    existing.location_type = row.location_type;
                }
                
                // Prefer non-empty scores
                if (!existing.home_score && row.home_score) {
                    existing.home_score = row.home_score;
                }
                if (!existing.away_score && row.away_score) {
                    existing.away_score = row.away_score;
                }
                
                // Update status if we have better info
                if (existing.status === 'scheduled' && row.status !== 'scheduled') {
                    existing.status = row.status;
                }
                
                // Prefer non-empty URLs
                if (!existing.boxscore_url && row.boxscore_url) {
                    existing.boxscore_url = row.boxscore_url;
                }
                if (!existing.schedule_url && row.schedule_url) {
                    existing.schedule_url = row.schedule_url;
                }
                
                gamesMap.set(game.dedupe_key, existing);
            } else {
                gamesMap.set(game.dedupe_key, row);
            }
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
