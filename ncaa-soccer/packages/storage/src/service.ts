
import { Game, PlayerStat } from '@ncaa/shared';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import * as fs from 'fs';
import * as path from 'path';

export class StorageService {
    private gamesPath: string;
    private statsPath: string;

    constructor(dataDir: string) {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        this.gamesPath = path.join(dataDir, 'master_games.csv');
        this.statsPath = path.join(dataDir, 'master_player_stats.csv');
    }

    // --- Games ---

    loadGames(): Game[] {
        if (!fs.existsSync(this.gamesPath)) {
            return [];
        }
        const fileContent = fs.readFileSync(this.gamesPath, 'utf-8');
        try {
            const records = parse(fileContent, {
                columns: true,
                cast: (value, context) => {
                    if (context.column === 'home_score' || context.column === 'away_score') {
                        return value === '' ? null : Number(value);
                    }
                    if (context.column === 'source_urls') {
                        try {
                            return JSON.parse(value);
                        } catch { return {}; }
                    }
                    return value;
                }
            }) as Game[]; // Cast to Game[]
            return records;
        } catch (e) {
            console.error('Failed to load games CSV', e);
            return [];
        }
    }

    saveGames(games: Game[]): void {
        const output = stringify(games, {
            header: true,
            columns: [
                'game_id', 'date', 'home_team_name', 'away_team_name',
                'home_score', 'away_score', 'location_type', 'status', 'dedupe_key',
                { key: 'source_urls', header: 'source_urls' }
                // Note: handling object stringification for source_urls might need a custom caster if stringify doesn't do it automatically for objects in cells.
                // csv-stringify usually handles objects if we provide a cast or transform, but default might be [object Object].
                // Let's handle it by mapping before stringify.
            ]
        });

        // Better approach: map games to flat objects for CSV
        const flatGames = games.map(g => ({
            ...g,
            source_urls: JSON.stringify(g.source_urls)
        }));

        const csvContent = stringify(flatGames, { header: true });

        fs.writeFileSync(this.gamesPath, csvContent);
    }

    upsertGames(newGames: Game[]): { added: number, updated: number } {
        const existing = this.loadGames();
        const map = new Map<string, Game>();

        // Load existing into map
        existing.forEach(g => map.set(g.dedupe_key, g));

        let added = 0;
        let updated = 0;

        for (const game of newGames) {
            if (map.has(game.dedupe_key)) {
                // Update logic: merge or overwrite?
                // For now, overwrite is generally safer if we trust the latest scrape
                // But we might want to preserve some fields if needed.
                // Simple overwrite for now.
                map.set(game.dedupe_key, game);
                updated++;
            } else {
                map.set(game.dedupe_key, game);
                added++;
            }
        }

        const allGames = Array.from(map.values());
        // valid sort by date?
        allGames.sort((a, b) => a.date.localeCompare(b.date));

        this.saveGames(allGames);
        return { added, updated };
    }

    // --- Player Stats ---
    // (Stubbed for now, implementing similarly later)
    upsertPlayerStats(newStats: PlayerStat[]): void {
        // TODO
    }
}
