import { Game } from '@ncaa/shared';
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
export declare class GameStorageAdapter {
    private baseDir;
    private verbose;
    private normalizeRow;
    constructor(baseDir: string, options?: GameStorageOptions);
    saveGames(games: Game[], season: string): Promise<void>;
}
export {};
//# sourceMappingURL=game_adapter.d.ts.map