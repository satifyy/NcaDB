import { z } from 'zod';

export const TeamSchema = z.object({
    team_id: z.string().describe("Canonical internal ID"),
    name_canonical: z.string(),
    conference: z.string().describe("Conference name, MVP: 'ACC'"),
    sport: z.literal("msoc").describe("Sport identifier"),
    aliases: z.array(z.string()).optional().describe("Alternative names for the team"),
    // New scraping metadata
    schedule_url: z.string().url().optional().describe("Men's soccer schedule URL"),
    platform_guess: z
        .enum(["sidearm", "wmt", "wmt_wp", "presto", "custom", "unknown"])
        .optional()
        .describe("Which parser reads this school: wmt is WMT's Nuxt product, wmt_wp its WordPress one"),
    parser_key: z.string().optional().describe("Registry key in @ncaa/parsers"),
    timezone: z.string().optional().describe("IANA zone the school quotes kickoff times in"),
});

export type Team = z.infer<typeof TeamSchema>;
