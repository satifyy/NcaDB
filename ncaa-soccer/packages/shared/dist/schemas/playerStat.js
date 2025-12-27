"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlayerStatSchema = void 0;
const zod_1 = require("zod");
exports.PlayerStatSchema = zod_1.z.object({
    game_id: zod_1.z.string(),
    team_id: zod_1.z.string(),
    player_name: zod_1.z.string(),
    player_key: zod_1.z.string().describe("Derived key: team_id:normalized_player_name"),
    jersey_number: zod_1.z.string().nullable().optional(),
    stats: zod_1.z.record(zod_1.z.union([zod_1.z.string(), zod_1.z.number(), zod_1.z.null()])).describe("Dynamic stats map"),
    // Optional convenience fields
    goals: zod_1.z.number().optional(),
    assists: zod_1.z.number().optional(),
    shots: zod_1.z.number().optional(),
    minutes: zod_1.z.number().optional(),
});
//# sourceMappingURL=playerStat.js.map