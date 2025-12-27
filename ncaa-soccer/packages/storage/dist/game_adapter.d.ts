import { Game } from '@ncaa/shared';
export declare class GameStorageAdapter {
    private baseDir;
    constructor(baseDir: string);
    saveGames(games: Game[], season: string): Promise<void>;
    private escapeCsv;
}
//# sourceMappingURL=game_adapter.d.ts.map