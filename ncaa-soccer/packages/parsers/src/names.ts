/**
 * Team-name handling shared by every platform.
 *
 * Schools write the same opponent a dozen ways — "Pitt", "Pittsburgh",
 * "University of Pittsburgh", "#3 NC State", "#24/RV University of Virginia" — and a
 * fixture only dedupes across two schools' sites if both spellings collapse to one
 * canonical name. {@link cleanTeamName} strips the decoration; {@link TeamNameResolver}
 * maps what is left onto the canonical name.
 *
 * WMT sites add a wrinkle: they store two names per opponent
 * (`opponent_name` / `opponent_school_name`) and which one holds the school is a
 * per-site data-entry choice. Clemson and Virginia put the school in both, while Notre
 * Dame puts the mascot in `opponent_name` ("Wolverines") and the school in
 * `opponent_school_name` ("Michigan") — except for a handful of rows where it is the
 * other way round. {@link TeamNameResolver.pickSchoolName} decides row by row.
 */

/**
 * Trailing "(...)" qualifiers that describe the fixture, not the school.
 *
 * Schools abbreviate the exhibition marker as well as spelling it out — "St. Bonaventure
 * (EX)", "CSUN (Exh.)" — and an unstripped marker makes a second team out of one, so the
 * short forms are matched too, but only when they are the whole parenthetical.
 */
const QUALIFIER_RE =
    /\s*\((?:\s*(?:ex|exh|exhib|scrim|free|gold division|blue division)\.?\s*|[^()]*\b(?:exhibition|scrimmage|friendly|round|rd\.?|final|finals|semifinal|quarterfinal|tournament|championship|classic|invitational|acc|ncaa|naia|njcaa|usl|mls|mlsnext|nwsl|uslc|usl\s*1|play-?in)\b[^()]*)\)\s*$/i;

/**
 * Whether a stripped qualifier said the fixture was an exhibition rather than a round.
 *
 * Exported because the marker outlives the name it was attached to: the pipeline cleans
 * the team-name columns but leaves `game_id` and `dedupe_key` as the site published them,
 * so the same pattern is what recovers the flag from a row already written to disk.
 * See {@link ./game_type}.
 */
export const EXHIBITION_RE = /exhibition|scrimmage|friendly|\(\s*(?:ex|exh|exhib|scrim)\.?\s*\)/i;

/**
 * Leading rank markers: "No. 7 Duke", "#5 Duke", "(9) North Carolina", the
 * poll/receiving-votes form "#24/RV University of Virginia", the several-polls form
 * some schools publish in full ("No. 12/13/17 Virginia", "No. RV/24/13 Louisville"),
 * tournament brackets'
 * "#2 Seed West Virginia" and "(#8 seed) Portland", the bracket form "[11] No. 5 Bryant",
 * and both the parenthesised "(rv) Delaware" and bare "RV San Francisco" a school just
 * outside the poll is listed as.
 *
 * The lone "seed)" is residue rather than a marker any site publishes: rows scraped
 * before this pattern handled "(#4 seed)" had the "(#4 " half stripped and the rest left
 * behind, so "seed) Kansas City" sits in the stored data. Matching it keeps those rows
 * resolving to their school until they are re-scraped.
 *
 * A parenthesised marker has to be matched as a whole rather than as an optional "("
 * before a number: "(#8 seed)" opens with the paren but leads with the "#", which a
 * number-first pattern walks straight past, leaving the decoration on the name.
 */
const POLL = String.raw`(?:\s*\/\s*[A-Za-z0-9-]+)*`;
const RANK_RE = new RegExp(
    String.raw`^\s*(?:` +
        // "[11] Bryant", "[9/4] Louisville", "[RV/24] Xavier"
        String.raw`\[\s*(?:rv|\d{1,2})${POLL}\s*\]` +
        // "(9) North Carolina", "(rv) Delaware", "(#8 seed) Portland", "(#2N) Sacramento State"
        String.raw`|\(\s*(?:rv|(?:#|no\s*\.?)?\s*\d{1,2}[A-Za-z]?${POLL}\s*(?:seed)?)\s*\)` +
        // Residue of a "(#4 seed)" stripped by an earlier, narrower pattern.
        String.raw`|seed\)` +
        String.raw`|rv` +
        // "No. 7", "No .13", "#5", "#24/RV", "#37/-"
        String.raw`|(?:no\s*\.?|#)\s*(?:\d{1,2}|rv)${POLL}` +
        // A bare poll pair with no marker at all: "14/9 UMass Lowell"
        String.raw`|\d{1,2}(?:\s*\/\s*[A-Za-z0-9-]+)+` +
    String.raw`)\s+(?:seed\s+)?`,
    'i'
);

/**
 * Bullets and separators some schedules prefix an opponent with: "• Fort Wayne".
 *
 * Stripped before the rank markers, since a decorated name can carry both.
 */
const LEADING_PUNCTUATION = /^[\s•·*\-–—|]+/;

/**
 * A trailing round, hung on the opponent rather than on the fixture.
 *
 * "Boston College - ACC Semifinals" is Boston College; left whole it is a second school
 * that plays one game a year. Schools separate it with a dash, a double dash or a slash
 * ("Memphis -- Wolstein Classic", "Charlotte/Alumni Weekend").
 *
 * A dash has to be spaced to count. "Pac-12 Tournament" is a round with no school in it
 * at all, and treating its hyphen as a separator leaves "Pac" — a team that plays three
 * opponents in an afternoon every November.
 */
const TRAILING_ROUND =
    /(?:\s+[-–—]{1,2}\s+|\s*\/\s*)[^-–—/]*\b(?:tournament|championship|semifinals?|quarterfinals?|finals?|round|classic|invitational|playoffs?|weekend|showcase)\b[^-–—/]*$/i;

/**
 * Common NCAA mascots. Used only as a tie-breaker when neither candidate name
 * resolves to a known team, so a miss degrades to "keep the site's own value"
 * rather than to a wrong answer.
 */
const MASCOTS = new Set(
    [
        'aggies', 'anteaters', 'antelopes', 'aztecs', 'badgers', 'bearcats', 'bears', 'beavers',
        'bengals', 'billikens', 'bison', 'blackbirds', 'blazers', 'blue demons', 'blue devils',
        'blue hens', 'blue hose', 'blue jays', 'blue raiders', 'bluejays', 'bobcats', 'boilermakers',
        'bonnies', 'braves', 'broncos', 'broncs', 'bruins', 'buccaneers', 'buckeyes', 'buffaloes',
        'bulldogs', 'bulls', 'cadets', 'cardinal', 'cardinals', 'catamounts', 'cavaliers', 'chanticleers',
        'chippewas', 'colonels', 'colonials', 'commodores', 'cornhuskers', 'cougars', 'cowboys',
        'crimson', 'crimson tide', 'crusaders', 'cyclones', 'demon deacons', 'devils', 'dolphins',
        'dons', 'dragons', 'dukes', 'eagles', 'explorers', 'falcons', 'fighting illini',
        'fighting irish', 'flames', 'flashes', 'flyers', 'flying dutchmen', 'friars', 'gaels',
        'gamecocks', 'gators', 'gauchos', 'generals', 'golden bears', 'golden eagles', 'golden flashes',
        'golden gophers', 'golden griffins', 'golden hurricane', 'gophers', 'governors', 'greyhounds',
        'griffins', 'grizzlies', 'hatters', 'hawkeyes', 'hawks', 'highlanders', 'hilltoppers',
        'hokies', 'hoosiers', 'hornets', 'horned frogs', 'hoyas', 'huskies', 'hurricanes', 'jackrabbits',
        'jaguars', 'jaspers', 'jayhawks', 'kangaroos', 'keydets', 'knights', 'lancers', 'leathernecks',
        'leopards', 'lions', 'lobos', 'longhorns', 'lumberjacks', 'mastodons', 'matadors', 'mavericks',
        'mean green', 'midshipmen', 'miners', 'minutemen', 'monarchs', 'mountaineers', 'mountain hawks',
        'musketeers', 'mustangs', 'nittany lions', 'norse', 'orange', 'ospreys', 'owls', 'paladins',
        'panthers', 'patriots', 'peacocks', 'penguins', 'phoenix', 'pilots', 'pioneers', 'pirates',
        'privateers', 'purple aces', 'purple eagles', 'quakers', 'racers', 'ragin cajuns', 'rainbow warriors',
        'rams', 'ramblers', 'raiders', 'ratters', 'razorbacks', 'rebels', 'red flash', 'red foxes',
        'red raiders', 'red storm', 'red wolves', 'redbirds', 'redhawks', 'retrievers', 'river hawks',
        'roadrunners', 'rockets', 'royals', 'runnin bulldogs', 'salukis', 'scarlet knights', 'seahawks',
        'seawolves', 'seminoles', 'shockers', 'skyhawks', 'sooners', 'spartans', 'spiders', 'stags',
        'sun devils', 'sycamores', 'tar heels', 'terrapins', 'terriers', 'thundering herd', 'tigers',
        'titans', 'toreros', 'tribe', 'trojans', 'utes', 'vandals', 'vikings', 'volunteers', 'warhawks',
        'warriors', 'wave', 'wildcats', 'wolf pack', 'wolfpack', 'wolverines', 'yellow jackets',
        'zips', 'zips'
    ]
);

export interface CleanedName {
    /** School name with rank markers and fixture qualifiers removed. */
    name: string;
    /** True when the raw value carried a rank marker ("No. 7", "(9)"). */
    ranked: boolean;
    /** True when a trailing fixture qualifier was stripped ("(NCAA First Round)"). */
    hadQualifier: boolean;
    /** True when the stripped qualifier said this was an exhibition. */
    exhibition: boolean;
}

/**
 * The handful of HTML entities that reach a team name.
 *
 * Sidearm renders "William & Mary" into its schedule markup as "William &amp; Mary", and
 * the ampersand survives into the stored name — where it makes a second school out of
 * one, since nothing downstream matches "William &amp; Mary" against "William & Mary".
 */
const ENTITIES: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    lsquo: '\u2018',
    rsquo: '\u2019',
    nbsp: ' '
};

/**
 * Numeric references are decoded by code point rather than from a table, because sites
 * pad them inconsistently — the same apostrophe arrives as `&#39;` and as `&#039;`.
 */
function decodeEntities(value: string): string {
    return value
        .replace(/&#(\d{1,6});/g, (match, code) => {
            const point = Number(code);
            return point > 0 && point < 0x110000 ? String.fromCodePoint(point) : match;
        })
        .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[String(name).toLowerCase()] ?? match);
}

export function cleanTeamName(raw: string | null | undefined): CleanedName {
    let name = decodeEntities(raw || '').replace(/\s+/g, ' ').trim();
    let ranked = false;
    let hadQualifier = false;
    let exhibition = false;

    name = name.replace(LEADING_PUNCTUATION, '');

    // Tournament rows stack markers: "#17 #2 Seed West Virginia" carries the national
    // ranking and the bracket seed, so stripping one leaves the other behind.
    for (let i = 0; i < 3; i++) {
        const rank = name.match(RANK_RE);
        if (!rank) break;
        ranked = true;
        name = name.slice(rank[0].length).trim();
    }

    // Strip repeatedly: "Michigan (NCAA First Round) (Exhibition)" is rare but cheap to handle.
    for (let i = 0; i < 3; i++) {
        const qualifier = name.match(QUALIFIER_RE);
        if (!qualifier) break;
        hadQualifier = true;
        if (EXHIBITION_RE.test(qualifier[0])) exhibition = true;
        name = name.slice(0, name.length - qualifier[0].length).trim();
    }

    // "Clemson * *" -> "Clemson" (conference-game markers)
    name = name.replace(/\s*\*+\s*/g, ' ').trim();

    // "Boston College - ACC Semifinals" -> "Boston College"
    for (let i = 0; i < 2; i++) {
        const round = name.match(TRAILING_ROUND);
        if (!round) break;
        hadQualifier = true;
        name = name.slice(0, name.length - round[0].length).trim();
    }

    return { name, ranked, hadQualifier, exhibition };
}

function isMascot(name: string): boolean {
    return MASCOTS.has(name.toLowerCase().replace(/[^a-z ]/g, '').trim());
}

/**
 * Maps site-supplied names onto the canonical names used across the dataset,
 * so a WMT row for "Pitt" dedupes against a Sidearm row for "Pittsburgh".
 */
export class TeamNameResolver {
    private aliases = new Map<string, string>();

    /** @param canonicalToAliases canonical display name -> alternative spellings */
    constructor(canonicalToAliases: Record<string, string[]> = {}) {
        // Exact spellings first, so a derived key can never displace a real one:
        // "Kentucky" must stay Kentucky even though "Northern Kentucky" is also known.
        const derived = new Map<string, Set<string>>();
        for (const [canonical, aliases] of Object.entries(canonicalToAliases)) {
            for (const name of [canonical, ...aliases]) {
                this.aliases.set(TeamNameResolver.key(name), canonical);
                for (const variant of TeamNameResolver.variants(name)) {
                    const owners = derived.get(variant) ?? new Set<string>();
                    owners.add(canonical);
                    derived.set(variant, owners);
                }
            }
        }
        // A derived key that two different schools both produce identifies neither of
        // them. Dropping "college" from Boston College and "university" from Boston
        // University both yield "boston"; registering it for whichever was seen first is
        // how Lehigh's Patriot League fixtures against Boston University ended up filed
        // as Boston College, with identical scores, in five separate seasons. Where the
        // derivation is ambiguous the name is left unresolved, which is recoverable —
        // the wrong answer is not.
        for (const [key, owners] of derived) {
            if (this.aliases.has(key) || owners.size > 1) continue;
            this.aliases.set(key, [...owners][0]);
        }
    }

    private static key(name: string): string {
        return name.toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    /**
     * Longer-form spellings the same school shows up under across sites:
     * "University of Kentucky", "Kentucky University", "Saint Mary's" / "St. Mary's".
     * Registered only where they do not collide with a name given explicitly.
     */
    private static variants(name: string): string[] {
        const out = new Set<string>();
        const add = (value: string) => {
            const key = TeamNameResolver.key(value);
            if (key) out.add(key);
        };
        add(name.replace(/\s*\([^)]*\)\s*$/, ''));  // "St. John's (NY)"
        add(name.replace(/^university\s+of\s+/i, ''));
        add(name.replace(/\s+(university|college)$/i, ''));
        add(`university of ${name}`);
        add(`${name} university`);
        // "College" as well as "University", and for the same reason. Without it the
        // expansion is one-sided: "Boston" grows into "Boston University" and stops,
        // which looks like a confident answer rather than the coin toss it is.
        add(`${name} college`);
        if (/^st\.?\s/i.test(name)) add(name.replace(/^st\.?\s/i, 'saint '));
        if (/^saint\s/i.test(name)) add(name.replace(/^saint\s/i, 'st. '));
        if (/\bstate$/i.test(name)) add(name.replace(/\bstate$/i, 'st.'));
        if (/\bst\.?$/i.test(name)) add(name.replace(/\bst\.?$/i, 'state'));
        return [...out];
    }

    /**
     * Canonical name for a known team, or null when the name is unrecognised.
     *
     * Box scores and schedules abbreviate the same school differently — "Michigan St.",
     * "St. John's (NY)", "Saint Mary's (CA)" — so the input is retried through the same
     * normalisations used to register names before giving up.
     */
    lookup(name: string): string | null {
        if (!name) return null;
        const direct = this.aliases.get(TeamNameResolver.key(name));
        if (direct) return direct;

        // Every variant is tried before answering, not just the first that hits. The
        // expansions run both ways — "Boston" grows into "Boston University" as readily
        // as "Boston College" shrinks into "Boston" — so returning the first match makes
        // the answer depend on the order the variants happen to be generated in. Where
        // the variants point at two different schools the name does not identify either,
        // and unresolved is the only honest answer.
        const hits = new Set<string>();
        for (const variant of TeamNameResolver.variants(name)) {
            const hit = this.aliases.get(variant);
            if (hit) hits.add(hit);
        }
        return hits.size === 1 ? [...hits][0] : null;
    }

    /** Canonical name when known, otherwise the name as given. */
    canonical(name: string): string {
        return this.lookup(name) || name;
    }

    /**
     * Chooses between the two names WMT stores for an opponent.
     *
     * `preferSecondary` is the site-level verdict from {@link detectSchoolNameField};
     * it only decides rows the per-row signals cannot.
     */
    pickSchoolName(
        primaryRaw: string | null | undefined,
        secondaryRaw: string | null | undefined,
        preferSecondary = false
    ): CleanedName {
        const primary = cleanTeamName(primaryRaw);
        const secondary = cleanTeamName(secondaryRaw);

        if (!secondary.name) return primary;
        if (!primary.name) return secondary;
        if (primary.name === secondary.name) return primary;

        // 1. A name we already know beats one we do not.
        const primaryKnown = this.lookup(primary.name) !== null;
        const secondaryKnown = this.lookup(secondary.name) !== null;
        if (primaryKnown !== secondaryKnown) return primaryKnown ? primary : secondary;

        // 2. Fixture qualifiers ("(NCAA First Round)") are attached to the school name.
        if (primary.hadQualifier !== secondary.hadQualifier) {
            return primary.hadQualifier ? primary : secondary;
        }

        // 3. A recognised mascot is never the school name.
        const primaryMascot = isMascot(primary.name);
        const secondaryMascot = isMascot(secondary.name);
        if (primaryMascot !== secondaryMascot) return primaryMascot ? secondary : primary;

        // 4. Fall back to whichever field this site fills in with schools.
        return preferSecondary ? secondary : primary;
    }

    /**
     * Decides which of the two fields a site uses for school names by scoring both
     * across a whole season: the field with more recognisable schools wins.
     */
    detectSchoolNameField(rows: Array<{ primary?: string | null; secondary?: string | null }>): {
        preferSecondary: boolean;
    } {
        let primaryScore = 0;
        let secondaryScore = 0;
        for (const row of rows) {
            const primary = cleanTeamName(row.primary);
            const secondary = cleanTeamName(row.secondary);
            if (primary.name === secondary.name) continue;
            if (this.lookup(primary.name)) primaryScore++;
            if (this.lookup(secondary.name)) secondaryScore++;
            if (isMascot(primary.name)) secondaryScore++;
            if (isMascot(secondary.name)) primaryScore++;
        }
        return { preferSecondary: secondaryScore > primaryScore };
    }
}

/** The subset of a game row this module can normalise. */
export interface NormalisableGame {
    home_team_name: string;
    away_team_name: string;
    home_team_ranked?: boolean;
    away_team_ranked?: boolean;
    date: string;
    dedupe_key: string;
}

/**
 * Dedupe key shared by every parser: date plus both teams, alphabetically, so the two
 * schools in a fixture derive the same key from their own points of view.
 */
export function makeDedupeKey(date: string, homeTeam: string, awayTeam: string): string {
    const [first, second] = [homeTeam, awayTeam].sort();
    return `${date}-${first.replace(/\s+/g, '-')}-${second.replace(/\s+/g, '-')}`;
}

/**
 * Rewrites a game's team names to their canonical form and rebuilds its dedupe key.
 *
 * Applied to every row before storage, this is what stops one fixture being filed
 * twice — once as "#3 Clemson vs Pittsburgh" from Pitt's site and once as
 * "Clemson vs Pittsburgh" from Clemson's. A rank found in the name is moved onto the
 * `*_ranked` flag, which is where the schema keeps it.
 */
export function normalizeGameNames<T extends NormalisableGame>(game: T, resolver: TeamNameResolver): T {
    const home = cleanTeamName(game.home_team_name);
    const away = cleanTeamName(game.away_team_name);
    const homeName = resolver.canonical(home.name);
    const awayName = resolver.canonical(away.name);

    return {
        ...game,
        home_team_name: homeName,
        away_team_name: awayName,
        home_team_ranked: Boolean(game.home_team_ranked) || home.ranked,
        away_team_ranked: Boolean(game.away_team_ranked) || away.ranked,
        dedupe_key: makeDedupeKey(game.date, homeName, awayName)
    };
}
