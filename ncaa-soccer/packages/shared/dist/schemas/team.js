"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeamSchema = void 0;
const zod_1 = require("zod");
exports.TeamSchema = zod_1.z.object({
    team_id: zod_1.z.string().describe("Canonical internal ID"),
    name_canonical: zod_1.z.string(),
    conference: zod_1.z.string().describe("Conference name, MVP: 'ACC'"),
    sport: zod_1.z.literal("msoc").describe("Sport identifier"),
    aliases: zod_1.z.array(zod_1.z.string()).optional().describe("Alternative names for the team"),
    // New scraping metadata
    schedule_url: zod_1.z.string().url().optional().describe("Men's soccer schedule URL"),
    platform_guess: zod_1.z.enum(["sidearm", "presto", "wmt", "custom", "unknown"]).optional().describe("Likely scraping logic needed"),
    parser_key: zod_1.z.string().optional().describe("Registry key in @ncaa/parsers"),
});
//# sourceMappingURL=team.js.map