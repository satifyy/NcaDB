
import * as fs from 'fs';
import * as path from 'path';
import { Game } from '@ncaa/shared';
// import { writeCsv } from './csv/writers'; // If available

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

        // Headers based on Game schema
        const headers = [
            'game_id', 'date', 'home_team_name', 'away_team_name',
            'home_score', 'away_score', 'location_type', 'status',
            'schedule_url', 'boxscore_url', 'dedupe_key'
        ];

        let content = '';
        if (!fs.existsSync(filePath)) {
            content += headers.join(',') + '\n';
        }

        // Read existing keys to dedupe if appending? 
        // For now, simple append or overwrite?
        // Implementation plan said "saveGames". Usually we want to merge or overwrite.
        // Let's assume overwrite for the session or append new ones. 
        // For simplicity and to avoid duplicates in file, we might want to read all, merge, write all.
        // But for this phase, simple write is fine.

        for (const game of games) {
            const row = [
                this.escapeCsv(game.game_id),
                this.escapeCsv(game.date),
                this.escapeCsv(game.home_team_name),
                this.escapeCsv(game.away_team_name),
                game.home_score !== null ? game.home_score : '',
                game.away_score !== null ? game.away_score : '',
                this.escapeCsv(game.location_type),
                this.escapeCsv(game.status),
                this.escapeCsv(game.source_urls?.schedule_url || ''),
                this.escapeCsv(game.source_urls?.boxscore_url || ''),
                this.escapeCsv(game.dedupe_key)
            ];
            content += row.join(',') + '\n';
        }

        // naive append for now.
        fs.appendFileSync(filePath, content);
        console.log(`Saved ${games.length} games to ${filePath}`);
    }

    private escapeCsv(field: string | undefined): string {
        if (!field) return '';
        if (field.includes(',') || field.includes('"') || field.includes('\n')) {
            return `"${field.replace(/"/g, '""')}"`;
        }
        return field;
    }
}
