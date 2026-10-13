/**
 * Recognising a school across the spellings its sources use.
 *
 * Three vocabularies describe the same 200-odd programs: Wikipedia's roster gives formal
 * institution names ("Loyola Marymount University"), athletics sites give the short form
 * every scraped row carries ("Loyola Marymount"), and the hand-written inventories that
 * seeded the dataset gave a third ("LMU"). Discovery and inventory repair both have to
 * decide when two of those are the same school and which spelling to file it under, so
 * that logic lives here rather than in either script.
 */

import { cleanTeamName } from '@ncaa/parsers';

/** Anything that carries a name and the other spellings it answers to. */
export interface NamedEntry {
    name_canonical: string;
    aliases?: string[];
}

export function slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Keys a school name can be recognised by, so "St. John's (NY)" harvested off one site
 * matches "St. John's" in a roster.
 *
 * "State" is never stripped: doing so collapses Michigan and Michigan State onto the
 * same key, and whichever is seen first then claims the other's athletics domain.
 */
export function matchKeys(name: string): string[] {
    let base = cleanTeamName(name).name.toLowerCase();
    base = base.replace(/&/g, ' and ');
    base = base.replace(/\bst\.?\s*$/i, 'state');       // trailing "St." means State
    base = base.replace(/\bst\.?\s+(?=[a-z])/i, 'saint '); // leading "St." means Saint
    base = base.replace(/\s*\([^)]*\)\s*$/, '');        // "(United States)" disambiguators

    const keys = new Set<string>([slug(base)]);
    // Rosters give formal institution names ("University of the Pacific",
    // "Saint Mary's College of California"); athletics sites use the short form.
    const stripped = base
        .replace(/^the\s+/, '')
        .replace(/^university\s+(?:of\s+the|of|at|in)\s+/, '')
        .replace(/\s+(?:university|college)\s+of\s+.+$/, '')
        .replace(/[,]\s+.+$/, '')
        .trim();
    keys.add(slug(stripped));
    keys.add(slug(stripped.replace(/\s+(university|college)$/, '')));
    keys.add(slug(base.replace(/\b(university|college)\b/g, '')));
    keys.delete('');
    return [...keys];
}

/**
 * The athletics-facing short form of a formal institution name.
 *
 * Only reached when discovery has nothing better: a name an earlier run established and
 * the spelling harvested off an athletics site both beat this. Deliberately
 * conservative, because a wrong shortening files a school under a name no scraped row
 * will ever carry. Dropping a trailing "College" is merely usually right — it would
 * turn Boston College into Boston — so it is left alone.
 */
export function shortSchoolName(name: string): string {
    const short = name
        .replace(/\s*\([^)]*\)\s*$/, '')                    // "(United States)" disambiguators
        .replace(/\s+(?:University|College)\s+of\s+.+$/i, '') // "Saint Mary's College of California"
        .replace(/^The\s+/i, '')
        .replace(/^University\s+(?:of\s+the|of|at|in)\s+/i, '') // "University of the Pacific"
        .replace(/\s+University$/i, '')                        // "Clemson University"
        .trim();
    return short || name.trim();
}

/** Every spelling an inventory entry answers to. */
export function entryNames(team: NamedEntry): string[] {
    return [team.name_canonical, ...(team.aliases || [])];
}

/**
 * Whether two names denote one school, rather than neighbours that merely share a
 * generic key.
 *
 * `matchKeys` deliberately emits a loose key beside the exact one, so a short form still
 * finds its long form. That makes shared keys too weak to be identity on their own:
 * "Boston College" and "Boston University" both answer to `boston` and are different
 * schools, while "Pacific" and "University of the Pacific" share `pacific` and are the
 * same one. Containment separates them — a longer spelling of one school answers to
 * every key its short form does and adds a more specific one, whereas two schools each
 * hold a specific key the other lacks.
 */
export function sameSchool(a: string, b: string): boolean {
    const [x, y] = [new Set(matchKeys(a)), new Set(matchKeys(b))];
    return [...x].every(key => y.has(key)) || [...y].every(key => x.has(key));
}

/** Whether two inventory entries describe the same school, under any of their spellings. */
export function sameEntry(a: NamedEntry, b: NamedEntry): boolean {
    return entryNames(a).some(x => entryNames(b).some(y => sameSchool(x, y)));
}

/**
 * The entries seen so far, searchable by any spelling a school answers to.
 *
 * Scanned rather than keyed, because identity is containment between key sets and not
 * key equality: a map keyed on match keys files Boston College and Boston University
 * under the same `boston` and silently merges them. At ~200 schools the scan is free.
 */
export class SchoolIndex<T extends NamedEntry> {
    private entries: T[] = [];

    /** Adds an entry, or returns the existing one describing the same school. */
    add(entry: T): T | undefined {
        const existing = this.find(entry);
        if (existing) return existing;
        this.entries.push(entry);
        return undefined;
    }

    /** Replaces the entry describing the same school as `entry`, or adds it. */
    replace(entry: T): void {
        const index = this.entries.findIndex(known => sameEntry(known, entry));
        if (index === -1) this.entries.push(entry);
        else this.entries[index] = entry;
    }

    find(nameOrEntry: string | NamedEntry): T | undefined {
        const entry = typeof nameOrEntry === 'string' ? { name_canonical: nameOrEntry } : nameOrEntry;
        return this.entries.find(known => sameEntry(known, entry));
    }

    /**
     * The one entry this name denotes, or nothing when it denotes several.
     *
     * {@link find} answers with the first match, which is what building an inventory
     * wants — an entry is either already present or it is not. Resolving a *scraped*
     * name is the opposite problem: "Boston" is contained by both Boston College and
     * Boston University, and answering with whichever was added first files one school's
     * results under the other's name. Every ambiguous name in this dataset is a short
     * form, and a short form that fits two schools identifies neither.
     */
    findUnique(name: string): T | undefined {
        const entry = { name_canonical: name };
        const matches = this.entries.filter(known => sameEntry(known, entry));
        return matches.length === 1 ? matches[0] : undefined;
    }

    all(): T[] {
        return [...this.entries];
    }

    get size(): number {
        return this.entries.length;
    }
}

/**
 * The name the dataset should file a school under.
 *
 * Rosters give formal institution names ("Loyola Marymount University") while every
 * scraped row carries the athletics spelling ("Loyola Marymount"), so taking the roster
 * name at face value files the same school twice — once per source. An established name
 * wins outright; failing that the harvested athletics spelling is preferred over the
 * roster name whenever it is no longer, since it is the one games.csv will hold.
 */
export function pickCanonicalName(rosterName: string, harvestedName?: string, establishedName?: string): string {
    if (establishedName) return establishedName;
    const roster = shortSchoolName(rosterName);
    // Harvest keys are what matched this school to its domain, so a harvested name is
    // always a spelling of the same school — never a mascot from an unrelated row.
    if (harvestedName && harvestedName.length <= roster.length) return harvestedName;
    return roster;
}

/** Alias list for an entry: every other spelling we know, minus the canonical one. */
export function mergeAliases(canonical: string, candidates: (string | undefined)[]): string[] {
    const seen = new Set([canonical.toLowerCase()]);
    const aliases: string[] = [];
    for (const candidate of candidates) {
        const value = candidate?.trim();
        if (!value || seen.has(value.toLowerCase())) continue;
        seen.add(value.toLowerCase());
        aliases.push(value);
    }
    return aliases;
}

/** The stable id form of a canonical name: `NC State` -> `NC_STATE`. */
export function teamId(name: string): string {
    return name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}
