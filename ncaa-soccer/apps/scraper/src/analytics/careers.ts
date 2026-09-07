/**
 * Where one player's career ends and another person's begins.
 *
 * All the dataset has to identify a player is a name, and a name is not a person. Two
 * tests separate them. The first is **overlap**: one player cannot be on two rosters in
 * the same season, so a name appearing at two schools at once is at least two people, and
 * none of its stints are joined. That test lives with the career builder.
 *
 * The second is **time**, and it only became necessary once the dataset stretched past a
 * few seasons. Non-overlapping stints were enough over five years; over eleven they are
 * not, because a 2016 senior and a 2026 freshman with the same name do not overlap
 * either. Left unchecked that produced 225 careers longer than any college career can be
 * — including three separate names each showing the same six schools from 2016 to 2026,
 * which is the giveaway: the rule was chaining strangers who merely never coincided.
 */

/**
 * The longest a college career can plausibly run, in seasons.
 *
 * Four years of eligibility, a redshirt year, and the extra year the NCAA granted for
 * 2020. Anything longer is two people.
 */
export const MAX_CAREER_SEASONS = 6;

/**
 * A gap this long or shorter stays inside one career.
 *
 * One season away is a redshirt or an injury; it is also what an excluded season looks
 * like from here, since a player who appears in 2019 and 2021 has a hole in the middle
 * because 2020 is not in the dataset, not because they left.
 */
export const MAX_CAREER_GAP = 2;

/**
 * Cuts a name's seasons into the careers they plausibly belong to.
 *
 * Returns the index of the career each season falls in, so two stints separated by five
 * empty years become two people rather than one implausible one.
 */
export function careerSegments(seasons: string[]): Map<string, number> {
    const ordered = [...new Set(seasons)].sort();
    const segment = new Map<string, number>();
    let index = 0;
    let start = ordered[0];
    let previous: string | undefined;

    for (const season of ordered) {
        if (previous !== undefined) {
            const gap = Number(season) - Number(previous);
            const span = Number(season) - Number(start) + 1;
            if (gap > MAX_CAREER_GAP || span > MAX_CAREER_SEASONS) {
                index++;
                start = season;
            }
        }
        segment.set(season, index);
        previous = season;
    }
    return segment;
}
