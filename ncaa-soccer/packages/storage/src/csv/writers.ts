import { Game, PlayerStat } from '@ncaa/shared';
// import { promises as fs } from 'fs'; // mocked for now

export async function writeGamesCsv(games: Game[], path: string): Promise<void> {
    // TODO: Implement CSV writing logic
    console.log(`[STUB] Writing ${games.length} games to ${path}`);
    return Promise.resolve();
}

export async function writePlayerStatsCsv(rows: PlayerStat[], path: string): Promise<void> {
    // TODO: Implement CSV writing logic
    console.log(`[STUB] Writing ${rows.length} player stats to ${path}`);
    return Promise.resolve();
}
