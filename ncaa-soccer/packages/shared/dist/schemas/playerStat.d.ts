import { z } from 'zod';
export declare const PlayerStatSchema: z.ZodObject<{
    game_id: z.ZodString;
    team_id: z.ZodString;
    player_name: z.ZodString;
    player_key: z.ZodString;
    jersey_number: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    stats: z.ZodRecord<z.ZodString, z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodNull]>>;
    goals: z.ZodOptional<z.ZodNumber>;
    assists: z.ZodOptional<z.ZodNumber>;
    shots: z.ZodOptional<z.ZodNumber>;
    minutes: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    team_id: string;
    game_id: string;
    player_name: string;
    player_key: string;
    stats: Record<string, string | number | null>;
    jersey_number?: string | null | undefined;
    goals?: number | undefined;
    assists?: number | undefined;
    shots?: number | undefined;
    minutes?: number | undefined;
}, {
    team_id: string;
    game_id: string;
    player_name: string;
    player_key: string;
    stats: Record<string, string | number | null>;
    jersey_number?: string | null | undefined;
    goals?: number | undefined;
    assists?: number | undefined;
    shots?: number | undefined;
    minutes?: number | undefined;
}>;
export type PlayerStat = z.infer<typeof PlayerStatSchema>;
//# sourceMappingURL=playerStat.d.ts.map