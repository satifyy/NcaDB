import { z } from 'zod';

export const GameSchema = z.object({
    game_id: z.string().describe("Internal key; derived"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("ISO date YYYY-MM-DD"),
    home_team_id: z.string().optional(),
    away_team_id: z.string().optional(),
    home_team_name: z.string(),
    away_team_name: z.string(),
    home_score: z.number().nullable(),
    away_score: z.number().nullable(),
    location_type: z.enum(["home", "away", "neutral", "unknown"]),
    status: z.enum(["final", "scheduled", "canceled", "postponed", "unknown"]),
    source_urls: z.object({
        schedule_url: z.string().optional(),
        boxscore_url: z.string().optional(),
        recap_url: z.string().optional(),
    }),
    dedupe_key: z.string().describe("Derived distinct key"),
});

export type Game = z.infer<typeof GameSchema>;
