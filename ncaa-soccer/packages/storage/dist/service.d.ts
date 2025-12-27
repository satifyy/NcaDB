import { Game, PlayerStat } from '@ncaa/shared';
export declare class StorageService {
    private gamesPath;
    private statsPath;
    constructor(dataDir: string);
    loadGames(): Game[];
    saveGames(games: Game[]): void;
    upsertGames(newGames: Game[]): {
        added: number;
        updated: number;
    };
    upsertPlayerStats(newStats: PlayerStat[]): void;
}
//# sourceMappingURL=service.d.ts.map