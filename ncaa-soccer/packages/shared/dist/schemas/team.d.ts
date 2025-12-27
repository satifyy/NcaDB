import { z } from 'zod';
export declare const TeamSchema: z.ZodObject<{
    team_id: z.ZodString;
    name_canonical: z.ZodString;
    conference: z.ZodString;
    sport: z.ZodLiteral<"msoc">;
    aliases: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    schedule_url: z.ZodOptional<z.ZodString>;
    platform_guess: z.ZodOptional<z.ZodEnum<["sidearm", "presto", "wmt", "custom", "unknown"]>>;
    parser_key: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    team_id: string;
    name_canonical: string;
    conference: string;
    sport: "msoc";
    aliases?: string[] | undefined;
    schedule_url?: string | undefined;
    platform_guess?: "sidearm" | "presto" | "wmt" | "custom" | "unknown" | undefined;
    parser_key?: string | undefined;
}, {
    team_id: string;
    name_canonical: string;
    conference: string;
    sport: "msoc";
    aliases?: string[] | undefined;
    schedule_url?: string | undefined;
    platform_guess?: "sidearm" | "presto" | "wmt" | "custom" | "unknown" | undefined;
    parser_key?: string | undefined;
}>;
export type Team = z.infer<typeof TeamSchema>;
//# sourceMappingURL=team.d.ts.map