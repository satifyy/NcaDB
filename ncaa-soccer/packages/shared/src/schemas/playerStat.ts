import { z } from 'zod';

export const PlayerStatSchema = z.object({
    game_id: z.string(),
    team_id: z.string(),
    player_name: z.string(),
    player_key: z.string().describe("Derived key: team_id:normalized_player_name"),
    jersey_number: z.string().nullable().optional(),
    stats: z.record(z.union([z.string(), z.number(), z.null()])).describe("Dynamic stats map"),
    // Optional convenience fields
    goals: z.number().optional(),
    assists: z.number().optional(),
    shots: z.number().optional(),
    minutes: z.number().optional(),
});

export type PlayerStat = z.infer<typeof PlayerStatSchema>;
