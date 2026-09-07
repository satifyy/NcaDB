
import * as fs from 'fs';
import * as path from 'path';
import { Game } from '@ncaa/shared';
import { readAll } from './csv/read';
import { writeRows } from './csv/write';

/** A CSV row as stored on disk. */
type GameRow = Record<string, string>;

export interface GameStorageOptions {
    verbose?: boolean;
    /**
     * Rewrites a row's team names and `dedupe_key` before it is keyed.
     *
     * Applied to rows already on disk as well as incoming ones, so a fixture stored
     * earlier under a decorated name ("#3 Clemson") merges with the same fixture
     * arriving under its canonical name rather than sitting beside it.
     */
    normalizeRow?: (row: GameRow) => GameRow;
}

const isPdf = (url: string | undefined): boolean => /\.pdf(\?|#|$)/i.test(url || '');

/**
 * Both schools in a fixture publish their own box score, and one of them is sometimes
 * empty — a school's stats feed can carry no players at all, or offer only a PDF.
 * Keeping the second URL as `boxscore_url_alt` gives the box-score stage somewhere to
 * fall back to instead of losing the game. A parseable HTML page always takes the
 * primary slot over a PDF.
 */
function mergeBoxscoreUrls(merged: GameRow, from: GameRow): void {
    const candidates = [merged.boxscore_url, merged.boxscore_url_alt, from.boxscore_url, from.boxscore_url_alt]
        .map(url => (url || '').trim())
        .filter(Boolean);

    const unique: string[] = [];
    for (const url of candidates) {
        if (!unique.includes(url)) unique.push(url);
    }
    // Stable sort that lifts HTML box scores above PDFs without reordering equals.
    const ranked = unique
        .map((url, index) => ({ url, index }))
        .sort((a, b) => Number(isPdf(a.url)) - Number(isPdf(b.url)) || a.index - b.index)
        .map(entry => entry.url);

    merged.boxscore_url = ranked[0] || '';
    merged.boxscore_url_alt = ranked[1] || '';
}

/**
 * Keeps whichever side of a duplicate pair actually has the field filled in.
 *
 * The two rows describe one fixture from two schools' points of view, so they often
 * disagree on which team is listed first. Per-team fields are read through that
 * orientation rather than by column name — otherwise a 4-0 would be copied in as 0-4.
 */
function mergeRows(into: GameRow, from: GameRow): GameRow {
    const merged = { ...into };
    const aligned =
        merged.home_team_name === from.home_team_name && merged.away_team_name === from.away_team_name;
    const inverted =
        merged.home_team_name === from.away_team_name && merged.away_team_name === from.home_team_name;

    if (merged.location_type === 'unknown' && from.location_type && from.location_type !== 'unknown') {
        merged.location_type = from.location_type;
    }
    if (merged.status === 'scheduled' && from.status && from.status !== 'scheduled') {
        merged.status = from.status;
    }
    for (const field of ['schedule_url', 'game_id']) {
        if (!merged[field] && from[field]) merged[field] = from[field];
    }
    // `regular` is what a row says when its source hung no marker on the fixture, so it
    // loses to any other value: one school calling the game an exhibition is a claim,
    // and the other school not mentioning it is not a counter-claim.
    if ((!merged.game_type || merged.game_type === 'regular') && from.game_type && from.game_type !== 'regular') {
        merged.game_type = from.game_type;
    }
    mergeBoxscoreUrls(merged, from);

    if (aligned || inverted) {
        // When inverted, the other row's "home" value describes our away team.
        for (const side of ['home', 'away'] as const) {
            const other = inverted ? (side === 'home' ? 'away' : 'home') : side;
            if (!merged[`${side}_score`] && from[`${other}_score`]) {
                merged[`${side}_score`] = from[`${other}_score`];
            }
            if (from[`${other}_team_ranked`] === 'true') {
                merged[`${side}_team_ranked`] = 'true';
            }
        }
    }
    return merged;
}

export class GameStorageAdapter {
    private baseDir: string;
    private verbose: boolean;
    private normalizeRow: (row: GameRow) => GameRow;

    constructor(baseDir: string, options?: GameStorageOptions) {
        this.baseDir = baseDir;
        this.verbose = options?.verbose || false;
        this.normalizeRow = options?.normalizeRow || (row => row);
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
            'schedule_url', 'boxscore_url', 'boxscore_url_alt', 'dedupe_key',
            'game_type'
        ];

        const gamesMap = new Map<string, any>();

        // 1. Read existing
        if (fs.existsSync(filePath)) {
            try {
                for (const raw of readAll<GameRow>(filePath)) {
                    const record = this.normalizeRow(raw);
                    if (!record.dedupe_key) continue;
                    const existing = gamesMap.get(record.dedupe_key);
                    if (existing) {
                        // Two stored rows normalised onto the same fixture; keep the
                        // richer of the pair rather than whichever was read last.
                        gamesMap.set(record.dedupe_key, mergeRows(existing, record));
                    } else {
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
            const row = this.normalizeRow({
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
                boxscore_url_alt: '',
                dedupe_key: game.dedupe_key,
                game_type: game.game_type || ''
            });

            // Smart merge: if game already exists, update with better data
            const existing = gamesMap.get(row.dedupe_key);
            if (existing) {
                if (this.verbose) {
                    console.log(`🔄 Duplicate detected: ${row.dedupe_key}`);
                }
                gamesMap.set(row.dedupe_key, mergeRows(existing, row));
            } else {
                gamesMap.set(row.dedupe_key, row);
            }
        }

        // 3. Write back
        const allGames = Array.from(gamesMap.values());

        // ensure sorting by date
        allGames.sort((a, b) => a.date.localeCompare(b.date));

        writeRows(filePath, allGames, headers);
        console.log(`Saved ${games.length} games (merged with existing) to ${filePath}`);
    }
}
