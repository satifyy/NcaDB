/**
 * Which box-score link each fixture is read from.
 *
 * A box-score URL that several fixtures point at cannot be the box score of any one of
 * them. Some schools publish a single stale link on every row — Winthrop hands out
 * `boxscore.aspx?id=23965` for its whole season — and scraping it once per fixture
 * credits that one game's players with the same goals four or five times over. Which
 * fixture it really belongs to is not knowable from the page, so a claimant is never
 * attributed that page.
 *
 * A claimant whose other school published its own copy keeps that copy instead: an
 * alternate link that no other fixture points at, as primary or alternate, names this
 * fixture alone. The page is still checked against the fixture when it is read. A
 * claimant with no such alternate is dropped, as before.
 */

export interface LinkedGame {
    game_id: string;
    boxscore_url?: string;
    boxscore_url_alt?: string;
    /** Set when the link read is a substitute for the fixture's own (see {@link contradictsScore}). */
    via_alternate?: boolean;
}

export function assignBoxscoreLinks<T extends LinkedGame>(games: T[]): { games: T[]; rescued: string[]; dropped: string[] } {
    const byPrimary = new Map<string, T[]>();
    const claims = new Map<string, number>();
    for (const game of games) {
        const url = (game.boxscore_url || '').trim();
        if (url) byPrimary.set(url, [...(byPrimary.get(url) || []), game]);
        for (const link of [game.boxscore_url, game.boxscore_url_alt]) {
            const key = (link || '').trim();
            if (key) claims.set(key, (claims.get(key) || 0) + 1);
        }
    }
    const rescued = new Map<string, string>();
    const dropped = new Set<string>();
    for (const [url, claimants] of byPrimary) {
        if (claimants.length < 2) continue;
        for (const g of claimants) {
            const alt = (g.boxscore_url_alt || '').trim();
            if (alt && alt !== url && claims.get(alt) === 1) rescued.set(g.game_id, alt);
            else dropped.add(g.game_id);
        }
    }
    return {
        games: games
            .filter(g => !dropped.has(g.game_id))
            .map(g => (rescued.has(g.game_id) ? { ...g, boxscore_url: rescued.get(g.game_id)!, boxscore_url_alt: '', via_alternate: true } : g)),
        rescued: [...rescued.keys()],
        dropped: [...dropped]
    };
}

/**
 * Whether a box score gives either side more goals than that side scored.
 *
 * A substitute link can still be the wrong page: Winthrop's site hands out stale
 * `boxscore.aspx` ids, and the one it lists as the other copy of an 8-0 win is a 0-3
 * loss to someone else. Player goals can fall short of a final score (own goals,
 * unattributed goals) but never exceed it, so a side over its score means the page is
 * another game. Sides without a final score are not judged.
 */
export function contradictsScore(
    rows: { team_id: string; goals: number | null }[],
    sides: { name: string; score: number | null }[]
): boolean {
    return sides.some(side => {
        if (side.score === null || !Number.isFinite(side.score)) return false;
        const goals = rows.filter(r => r.team_id === side.name).reduce((n, r) => n + (r.goals ?? 0), 0);
        return goals > side.score;
    });
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * How strongly an abbreviation points at a team name.
 *
 * "VIL" prefixes "Villanova"; "GSU" opens with the initials of "Georgia State". Scores
 * are only ever compared against each other within one game, so the absolute values
 * just need to rank prefix matches above initial matches and longer matches above
 * shorter ones.
 */
export function affinity(label: string, team: string): number {
    const l = slug(label);
    const t = slug(team);
    if (!l || !t) return 0;
    if (l === t) return 100;
    if (t.startsWith(l)) return 50 + l.length;
    if (l.startsWith(t)) return 40 + t.length;
    const initials = team.split(/\s+/).filter(Boolean).map(word => word[0]).join('').toLowerCase();
    if (initials.length > 1 && l.startsWith(initials)) return 20 + initials.length;
    if (initials.length > 1 && initials.startsWith(l)) return 15 + l.length;
    return 0;
}

/**
 * Whether a box-score label is a short abbreviation of this team: up to five letters,
 * matching the team's name by prefix or initials ("BC" for Blackburn College, "VIL" for
 * Villanova). A full name never counts, however it resolves.
 */
export function abbreviates(label: string, team: string): boolean {
    return /^[A-Za-z&.]{1,5}$/.test(label.trim()) && affinity(label, team) > 0;
}
