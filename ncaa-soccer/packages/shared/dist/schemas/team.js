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
    platform_guess: zod_1.z
        .enum(["sidearm", "wmt", "wmt_wp", "presto", "custom", "unknown"])
        .optional()
        .describe("Which parser reads this school: wmt is WMT's Nuxt product, wmt_wp its WordPress one"),
    parser_key: zod_1.z.string().optional().describe("Registry key in @ncaa/parsers"),
    timezone: zod_1.z.string().optional().describe("IANA zone the school quotes kickoff times in"),
});
//# sourceMappingURL=team.js.map