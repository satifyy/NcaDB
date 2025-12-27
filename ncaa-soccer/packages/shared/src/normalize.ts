export function normalizeTeamName(raw: string): string {
    // strip rankings like "No. 7", trim, collapse whitespace
    return raw
        .replace(/^No\.\s*\d+\s+/i, "") // Remove starting "No. 7 "
        .trim()
        .replace(/\s+/g, " "); // Collapse whitespace
}

export function normalizePlayerName(raw: string): string {
    return raw.trim().replace(/\s+/g, " ");
}
