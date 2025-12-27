import { normalizeTeamName, normalizePlayerName } from "./normalize";

export function makeGameDedupeKey(
    date: string,
    home_team_id: string,
    away_team_id: string
): string {
    // date:home:away normalized
    return `${date}:${home_team_id}:${away_team_id}`;
}

export function makeGameId(dedupe_key: string): string {
    // Simple base64 encoding of the key for ID-safety, or just use the key if valid chars
    // Requirement says "hash or stable encoding".
    // Let's use a simple buffer encoding for now to avoid long keys if they get complex,
    // but readable is often better. Let's stick to the key itself or a simple hash.
    // Using Buffer to base64
    return Buffer.from(dedupe_key).toString('base64').replace(/=/g, '');
}

export function makePlayerKey(team_id: string, player_name: string): string {
    return `${team_id}:${normalizePlayerName(player_name)}`;
}
