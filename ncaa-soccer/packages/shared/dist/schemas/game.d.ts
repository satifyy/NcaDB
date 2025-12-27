import { z } from 'zod';
export declare const GameSchema: z.ZodObject<{
    game_id: z.ZodString;
    date: z.ZodString;
    home_team_id: z.ZodOptional<z.ZodString>;
    away_team_id: z.ZodOptional<z.ZodString>;
    home_team_name: z.ZodString;
    away_team_name: z.ZodString;
    home_score: z.ZodNullable<z.ZodNumber>;
    away_score: z.ZodNullable<z.ZodNumber>;
    location_type: z.ZodEnum<["home", "away", "neutral", "unknown"]>;
    status: z.ZodEnum<["final", "scheduled", "canceled", "postponed", "unknown"]>;
    source_urls: z.ZodObject<{
        schedule_url: z.ZodOptional<z.ZodString>;
        boxscore_url: z.ZodOptional<z.ZodString>;
        recap_url: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        schedule_url?: string | undefined;
        boxscore_url?: string | undefined;
        recap_url?: string | undefined;
    }, {
        schedule_url?: string | undefined;
        boxscore_url?: string | undefined;
        recap_url?: string | undefined;
    }>;
    dedupe_key: z.ZodString;
}, "strip", z.ZodTypeAny, {
    game_id: string;
    date: string;
    home_team_name: string;
    away_team_name: string;
    home_score: number | null;
    away_score: number | null;
    location_type: "unknown" | "home" | "away" | "neutral";
    status: "unknown" | "final" | "scheduled" | "canceled" | "postponed";
    source_urls: {
        schedule_url?: string | undefined;
        boxscore_url?: string | undefined;
        recap_url?: string | undefined;
    };
    dedupe_key: string;
    home_team_id?: string | undefined;
    away_team_id?: string | undefined;
}, {
    game_id: string;
    date: string;
    home_team_name: string;
    away_team_name: string;
    home_score: number | null;
    away_score: number | null;
    location_type: "unknown" | "home" | "away" | "neutral";
    status: "unknown" | "final" | "scheduled" | "canceled" | "postponed";
    source_urls: {
        schedule_url?: string | undefined;
        boxscore_url?: string | undefined;
        recap_url?: string | undefined;
    };
    dedupe_key: string;
    home_team_id?: string | undefined;
    away_team_id?: string | undefined;
}>;
export type Game = z.infer<typeof GameSchema>;
//# sourceMappingURL=game.d.ts.map