"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeamNameResolver = void 0;
exports.cleanTeamName = cleanTeamName;
exports.makeDedupeKey = makeDedupeKey;
exports.normalizeGameNames = normalizeGameNames;
/** Trailing "(...)" qualifiers that describe the fixture, not the school. */
const QUALIFIER_RE = /\s*\((?:[^()]*\b(?:exhibition|scrimmage|friendly|round|rd\.?|final|finals|semifinal|quarterfinal|tournament|championship|classic|invitational|acc|ncaa|naia|njcaa|usl|mls|mlsnext|nwsl|uslc|usl\s*1|play-?in)\b[^()]*)\)\s*$/i;
/**
 * Leading rank markers: "No. 7 Duke", "#5 Duke", "(9) North Carolina", the
 * poll/receiving-votes form "#24/RV University of Virginia", and tournament brackets'
 * "#2 Seed West Virginia".
 */
const RANK_RE = /^\s*(?:no\.?\s*|#\s*|\(\s*)(\d{1,2})\s*(?:\/\s*[A-Za-z0-9]+)?\s*\)?\s+(?:seed\s+)?/i;
/**
 * Common NCAA mascots. Used only as a tie-breaker when neither candidate name
 * resolves to a known team, so a miss degrades to "keep the site's own value"
 * rather than to a wrong answer.
 */
const MASCOTS = new Set([
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
]);
function cleanTeamName(raw) {
    let name = (raw || '').replace(/\s+/g, ' ').trim();
    let ranked = false;
    let hadQualifier = false;
    let exhibition = false;
    // Tournament rows stack markers: "#17 #2 Seed West Virginia" carries the national
    // ranking and the bracket seed, so stripping one leaves the other behind.
    for (let i = 0; i < 3; i++) {
        const rank = name.match(RANK_RE);
        if (!rank)
            break;
        ranked = true;
        name = name.slice(rank[0].length).trim();
    }
    // Strip repeatedly: "Michigan (NCAA First Round) (Exhibition)" is rare but cheap to handle.
    for (let i = 0; i < 3; i++) {
        const qualifier = name.match(QUALIFIER_RE);
        if (!qualifier)
            break;
        hadQualifier = true;
        if (/exhibition|scrimmage|friendly/i.test(qualifier[0]))
            exhibition = true;
        name = name.slice(0, name.length - qualifier[0].length).trim();
    }
    // "Clemson * *" -> "Clemson" (conference-game markers)
    name = name.replace(/\s*\*+\s*/g, ' ').trim();
    return { name, ranked, hadQualifier, exhibition };
}
function isMascot(name) {
    return MASCOTS.has(name.toLowerCase().replace(/[^a-z ]/g, '').trim());
}
/**
 * Maps site-supplied names onto the canonical names used across the dataset,
 * so a WMT row for "Pitt" dedupes against a Sidearm row for "Pittsburgh".
 */
class TeamNameResolver {
    /** @param canonicalToAliases canonical display name -> alternative spellings */
    constructor(canonicalToAliases = {}) {
        this.aliases = new Map();
        // Exact spellings first, so a derived key can never displace a real one:
        // "Kentucky" must stay Kentucky even though "Northern Kentucky" is also known.
        const derived = [];
        for (const [canonical, aliases] of Object.entries(canonicalToAliases)) {
            for (const name of [canonical, ...aliases]) {
                this.aliases.set(TeamNameResolver.key(name), canonical);
                for (const variant of TeamNameResolver.variants(name)) {
                    derived.push([variant, canonical]);
                }
            }
        }
        for (const [key, canonical] of derived) {
            if (!this.aliases.has(key))
                this.aliases.set(key, canonical);
        }
    }
    static key(name) {
        return name.toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    /**
     * Longer-form spellings the same school shows up under across sites:
     * "University of Kentucky", "Kentucky University", "Saint Mary's" / "St. Mary's".
     * Registered only where they do not collide with a name given explicitly.
     */
    static variants(name) {
        const out = new Set();
        const add = (value) => {
            const key = TeamNameResolver.key(value);
            if (key)
                out.add(key);
        };
        add(name.replace(/\s*\([^)]*\)\s*$/, '')); // "St. John's (NY)"
        add(name.replace(/^university\s+of\s+/i, ''));
        add(name.replace(/\s+(university|college)$/i, ''));
        add(`university of ${name}`);
        add(`${name} university`);
        if (/^st\.?\s/i.test(name))
            add(name.replace(/^st\.?\s/i, 'saint '));
        if (/^saint\s/i.test(name))
            add(name.replace(/^saint\s/i, 'st. '));
        if (/\bstate$/i.test(name))
            add(name.replace(/\bstate$/i, 'st.'));
        if (/\bst\.?$/i.test(name))
            add(name.replace(/\bst\.?$/i, 'state'));
        return [...out];
    }
    /**
     * Canonical name for a known team, or null when the name is unrecognised.
     *
     * Box scores and schedules abbreviate the same school differently — "Michigan St.",
     * "St. John's (NY)", "Saint Mary's (CA)" — so the input is retried through the same
     * normalisations used to register names before giving up.
     */
    lookup(name) {
        if (!name)
            return null;
        const direct = this.aliases.get(TeamNameResolver.key(name));
        if (direct)
            return direct;
        for (const variant of TeamNameResolver.variants(name)) {
            const hit = this.aliases.get(variant);
            if (hit)
                return hit;
        }
        return null;
    }
    /** Canonical name when known, otherwise the name as given. */
    canonical(name) {
        return this.lookup(name) || name;
    }
    /**
     * Chooses between the two names WMT stores for an opponent.
     *
     * `preferSecondary` is the site-level verdict from {@link detectSchoolNameField};
     * it only decides rows the per-row signals cannot.
     */
    pickSchoolName(primaryRaw, secondaryRaw, preferSecondary = false) {
        const primary = cleanTeamName(primaryRaw);
        const secondary = cleanTeamName(secondaryRaw);
        if (!secondary.name)
            return primary;
        if (!primary.name)
            return secondary;
        if (primary.name === secondary.name)
            return primary;
        // 1. A name we already know beats one we do not.
        const primaryKnown = this.lookup(primary.name) !== null;
        const secondaryKnown = this.lookup(secondary.name) !== null;
        if (primaryKnown !== secondaryKnown)
            return primaryKnown ? primary : secondary;
        // 2. Fixture qualifiers ("(NCAA First Round)") are attached to the school name.
        if (primary.hadQualifier !== secondary.hadQualifier) {
            return primary.hadQualifier ? primary : secondary;
        }
        // 3. A recognised mascot is never the school name.
        const primaryMascot = isMascot(primary.name);
        const secondaryMascot = isMascot(secondary.name);
        if (primaryMascot !== secondaryMascot)
            return primaryMascot ? secondary : primary;
        // 4. Fall back to whichever field this site fills in with schools.
        return preferSecondary ? secondary : primary;
    }
    /**
     * Decides which of the two fields a site uses for school names by scoring both
     * across a whole season: the field with more recognisable schools wins.
     */
    detectSchoolNameField(rows) {
        let primaryScore = 0;
        let secondaryScore = 0;
        for (const row of rows) {
            const primary = cleanTeamName(row.primary);
            const secondary = cleanTeamName(row.secondary);
            if (primary.name === secondary.name)
                continue;
            if (this.lookup(primary.name))
                primaryScore++;
            if (this.lookup(secondary.name))
                secondaryScore++;
            if (isMascot(primary.name))
                secondaryScore++;
            if (isMascot(secondary.name))
                primaryScore++;
        }
        return { preferSecondary: secondaryScore > primaryScore };
    }
}
exports.TeamNameResolver = TeamNameResolver;
/**
 * Dedupe key shared by every parser: date plus both teams, alphabetically, so the two
 * schools in a fixture derive the same key from their own points of view.
 */
function makeDedupeKey(date, homeTeam, awayTeam) {
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
function normalizeGameNames(game, resolver) {
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
//# sourceMappingURL=names.js.map