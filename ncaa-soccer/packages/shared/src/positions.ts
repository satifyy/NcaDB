/**
 * Player positions, as box scores publish them and as the site groups them.
 *
 * Every platform spells a position its own way: Sidearm's hydration data says `gk`,
 * `def`, `mid`, `fwd` (or `fw`); its rendered tables say `GK`, `DEF`, `MID`, `FWD`; the
 * WMT feed says `GK`, `D`, `M`, `F`. The raw string is always stored as published, and
 * this maps it onto one of four groups for anything that ranks players by position.
 *
 * A box score lists the slot a player filled in that game, so the group belongs to a
 * game, not to a player. Combined labels ("D/M", "MF/FW") name two groups and are left
 * unmapped rather than resolved by guessing which one the coach meant.
 */

export type PositionGroup = 'GK' | 'DEF' | 'MID' | 'FWD';

export const POSITION_GROUPS: readonly PositionGroup[] = ['GK', 'DEF', 'MID', 'FWD'];

const GROUP_OF: Record<string, PositionGroup> = {};
const spell = (group: PositionGroup, ...labels: string[]) => labels.forEach(label => (GROUP_OF[label] = group));
spell('GK', 'g', 'gk', 'goalkeeper', 'goalie', 'keeper');
spell('DEF', 'd', 'df', 'def', 'b', 'back', 'defender', 'cb', 'lb', 'rb', 'fb', 'wb', 'lwb', 'rwb', 'sw');
spell('MID', 'm', 'mf', 'mid', 'midfield', 'midfielder', 'cm', 'dm', 'cdm', 'am', 'cam', 'lm', 'rm');
spell('FWD', 'f', 'fw', 'fwd', 'forward', 'a', 'att', 'attacker', 'st', 'striker', 'cf', 'w', 'lw', 'rw', 'wing', 'winger');

/** The group a published position names, or null when it names none or more than one. */
export function positionGroup(raw: string | null | undefined): PositionGroup | null {
    const label = (raw ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!label) return null;
    return GROUP_OF[label] ?? null;
}

/**
 * What the stored box-score rows are known to carry.
 *
 *   1  minutes, goals, assists, shots, shots on goal, saves — where saves were not
 *      published, the row says 0.
 *   2  additionally the published position, whether the player started, and the
 *      keeper's goals allowed; saves and goals allowed are blank, not 0, when the box
 *      score did not report them.
 *
 * A stored row older than the current version is what `backfill-capture` re-reads.
 */
export const BOXSCORE_CAPTURE_VERSION = 2;
