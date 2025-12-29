import { Game } from '@ncaa/shared';
export declare class GameStorageAdapter {
    private baseDir;
    private verbose;
    constructor(baseDir: string, options?: {
        verbose?: boolean;
    });
    saveGames(games: Game[], season: string): Promise<void>;
}
//# sourceMappingURL=game_adapter.d.ts.map