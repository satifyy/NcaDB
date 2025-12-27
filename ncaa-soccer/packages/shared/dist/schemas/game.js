"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameSchema = void 0;
const zod_1 = require("zod");
exports.GameSchema = zod_1.z.object({
    game_id: zod_1.z.string().describe("Internal key; derived"),
    date: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("ISO date YYYY-MM-DD"),
    home_team_id: zod_1.z.string().optional(),
    away_team_id: zod_1.z.string().optional(),
    home_team_name: zod_1.z.string(),
    away_team_name: zod_1.z.string(),
    home_score: zod_1.z.number().nullable(),
    away_score: zod_1.z.number().nullable(),
    location_type: zod_1.z.enum(["home", "away", "neutral", "unknown"]),
    status: zod_1.z.enum(["final", "scheduled", "canceled", "postponed", "unknown"]),
    source_urls: zod_1.z.object({
        schedule_url: zod_1.z.string().optional(),
        boxscore_url: zod_1.z.string().optional(),
        recap_url: zod_1.z.string().optional(),
    }),
    dedupe_key: zod_1.z.string().describe("Derived distinct key"),
});
//# sourceMappingURL=game.js.map