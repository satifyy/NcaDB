
import { ParseResult, ParserOptions } from '../types';
import { PlayerStat, PlayerStatSchema } from '@ncaa/shared';
import * as cheerio from 'cheerio';
// import { z } from 'zod'; // Not needed for HTML parsing unless we validate the final object

/** `'1'`/`'0'` (or a number) as 1/0; anything else says nothing about who started. */
function startedFlag(value: unknown): number | null {
    const text = String(value ?? '').trim();
    if (text === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? (n > 0 ? 1 : 0) : null;
}

/**
 * Whether a row is one of the section labels Sidearm tables split a squad with.
 *
 * Starters come first under "Starters", then "Substitutes" (some sites say "Reserves" or
 * "Bench"). A label row tells every player row after it how they entered the game; a
 * table with no labels says nothing about it, and its players are left unknown.
 */
function sectionOf(text: string): 'starters' | 'substitutes' | null {
    const label = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (/^starters?$/.test(label)) return 'starters';
    if (/^(substitutes?|subs|reserves?|bench)$/.test(label)) return 'substitutes';
    return null;
}

const letters = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** One row of a goalkeeping table: Sidearm publishes these apart from the player table. */
interface KeeperRow {
    /** The label of the player table the keeper table follows, when there is one. */
    team: string | null;
    name: string;
    jersey: string | null;
    minutes: number | null;
    goalsAllowed: number | null;
    saves: number | null;
}

/**
 * Folds goalkeeping rows into the player rows they describe.
 *
 * The goalie table names its squad differently from the player table often enough
 * ("Vermont - Goalie Statistics" under "UVM - Player Stats") that the caption is no key.
 * A keeper is matched by name — within the squad whose table it follows first, then
 * anywhere in the box score if that name is unique — and a keeper missing from the
 * player table becomes a row of their own rather than being dropped.
 *
 * Once a box score has a goalkeeping table, a player not in it has no keeper record:
 * their saves and goals allowed are absent, never 0. Without one, nothing is known about
 * either, and every row stays blank.
 */
function applyKeepers(stats: PlayerStat[], keepers: KeeperRow[], gameId: string): void {
    for (const stat of stats) {
        stat.stats.saves = null;
        stat.stats.goals_allowed = null;
    }
    for (const keeper of keepers) {
        const key = letters(keeper.name);
        const named = stats.filter(s => letters(s.player_name) === key);
        const sameTeam = named.filter(s => keeper.team !== null && s.team_id === keeper.team);
        const byJersey = named.filter(s => keeper.jersey && s.jersey_number === keeper.jersey);
        const match =
            sameTeam.length === 1 ? sameTeam[0] :
            named.length === 1 ? named[0] :
            byJersey.length === 1 ? byJersey[0] : undefined;
        if (match) {
            match.stats.saves = keeper.saves;
            match.stats.goals_allowed = keeper.goalsAllowed;
            if ((match.minutes ?? 0) === 0 && keeper.minutes) match.minutes = keeper.minutes;
            if (!match.stats.position) match.stats.position = 'GK';
            continue;
        }
        const team = keeper.team || 'Unknown';
        stats.push({
            game_id: gameId,
            team_id: team,
            player_name: keeper.name,
            player_key: `${letters(team)}:${key}`,
            jersey_number: keeper.jersey,
            minutes: keeper.minutes ?? undefined,
            stats: {
                position: 'GK',
                shots_on_goal: null,
                saves: keeper.saves,
                goals_allowed: keeper.goalsAllowed,
                started: null
            }
        } as PlayerStat);
    }
}

export class SidearmBoxScoreParser {

    private parseMinutes(value: string): number {
        if (!value) return 0;
        const trimmed = value.trim();
        const match = trimmed.match(/^(\d+):(\d{2})/);
        if (match) {
            const mins = parseInt(match[1], 10) || 0;
            const secs = parseInt(match[2], 10) || 0;
            return mins + secs / 60;
        }

        const numeric = parseFloat(trimmed.replace(/[^0-9.]/g, ''));
        return Number.isFinite(numeric) ? numeric : 0;
    }

    private normalizePlayerName(name: string): string {
        if (!name) return '';
        // Strip leading jersey numbers or symbols (e.g., "27 Ryan", "#12 John Doe")
        return name.replace(/^\s*[#-]?\s*\d+\s+/, '').trim();
    }

    parse(html: string, options?: ParserOptions): ParseResult {
        const $ = cheerio.load(html);
        const playerStats: PlayerStat[] = [];
        const gameId = options?.sourceUrl ? this.extractGameId(options.sourceUrl) : 'unknown-game';

        // Find tables with class 'sidearm-table overall-stats' OR 'w-full'
        // There are usually two: one for visitor, one for home. 
        // We need to identify which is which. 
        // The captions usually say "Home Team - Player Stats" or similar.

        // Try Nuxt parsing first (more robust for modern sites)
        const nuxtResult = this.parseNuxt(html, gameId);
        if (nuxtResult.playerStats.length > 0) {
            return nuxtResult;
        }

        // Handle new Sidearm "advanced-table" layout (Stanford/Virginia Tech)
        const advancedTableStats = this.parseAdvancedTables($, gameId);
        if (advancedTableStats.length > 0) {
            return { game: {}, playerStats: advancedTableStats };
        }

        // A captioned player table, read by its own headers.
        //
        // Tried before the positional reader below because that one identifies a player
        // table by counting columns — eight or more — and then reads fixed offsets out of
        // it. Layouts that omit a column break both halves at once: William & Mary
        // publishes "Pos, #, Player, SH, SOG, G, A" with no minutes, so every row was
        // discarded as invalid and the game was logged as having no player table at all,
        // when it had two.
        const captioned = this.parseCaptionedTables($, gameId);
        if (captioned.length > 0) {
            return { game: {}, playerStats: captioned };
        }

        // Find tables with class 'sidearm-table overall-stats' OR 'w-full'
        // Try multiple selectors to handle different Sidearm layouts
        let tables = $('table.sidearm-table.overall-stats');
        if (tables.length === 0) {
            tables = $('table.w-full');
        }
        if (tables.length === 0) {
            tables = $('table');
        }

        const keepers: KeeperRow[] = [];
        let sawKeeperTable = false;

        tables.each((i, table) => {
            const caption = $(table).find('caption').text().trim();
            // Heuristic to detect team from caption (e.g. "SMU - Player Stats")
            let teamName = 'Unknown';
            if (caption) {
                teamName = caption.split('-')[0].trim();
            }

            // A goalkeeping table — [Pos,] #, Player, MIN, GA, Saves — is too narrow for
            // the player reader below, and is the only place this layout reports saves.
            const headers = $(table).find('thead th, tr:first-child th')
                .map((_, cell) => $(cell).text().replace(/\s+/g, ' ').trim().toLowerCase()).get();
            const gaAt = headers.indexOf('ga');
            const savesAt = headers.findIndex(h => h === 'saves' || h === 'sv');
            if (gaAt !== -1 && savesAt !== -1) {
                sawKeeperTable = true;
                const nameAt = headers.findIndex(h => ['player', 'goalie', 'name'].includes(h));
                const jerseyAt = headers.indexOf('#');
                const minAt = headers.findIndex(h => h === 'min' || h === 'minutes');
                $(table).find('tbody tr').each((_, row) => {
                    const cols = $(row).find('td');
                    if (nameAt === -1 || cols.length !== headers.length) return;
                    const name = this.normalizePlayerName($(cols[nameAt]).text().trim());
                    if (!name || /^(totals?|tm team|team)$/i.test(name)) return;
                    const reported = (at: number) => {
                        const parsed = parseInt($(cols[at]).text().trim(), 10);
                        return Number.isFinite(parsed) ? parsed : null;
                    };
                    keepers.push({
                        team: teamName === 'Unknown' ? null : teamName,
                        name,
                        jersey: jerseyAt === -1 ? null : $(cols[jerseyAt]).text().trim() || null,
                        minutes: minAt === -1 ? null : Math.round(this.parseMinutes($(cols[minAt]).text())),
                        goalsAllowed: reported(gaAt),
                        saves: reported(savesAt)
                    });
                });
                return;
            }

            let section: 'starters' | 'substitutes' | null = null;
            const rows = $(table).find('tbody tr');
            rows.each((j, row) => {
                const cols = $(row).find('td');
                const label = sectionOf($(row).text());
                if (label) {
                    section = label;
                    return;
                }
                if (cols.length < 8) return; // Skip invalid rows

                // Column Mapping (based on inspection):
                // 0: Pos (fw, df, etc)
                // 1: # (Jersey)
                // 2: Player (Name, Link)
                // 3: SH
                // 4: SOG
                // 5: G
                // 6: A
                // 7: MIN

                const playerCell = $(cols[2]);
                const playerNameRaw = playerCell.text().trim();
                const playerName = this.normalizePlayerName(playerNameRaw);

                const jerseyNumber = $(cols[1]).text().trim();

                // Construct normalized key
                // For now, use teamId (if derived from header, e.g. "SMU") + player name
                const normalizedName = playerName.toLowerCase().replace(/[^a-z0-9]/g, '');
                const playerKey = `${teamName.toLowerCase().replace(/[^a-z0-9]/g, '')}:${normalizedName}`;

                // Stats
                const shots = parseInt($(cols[3]).text().trim(), 10) || 0;
                const sog = parseInt($(cols[4]).text().trim(), 10) || 0;
                const goals = parseInt($(cols[5]).text().trim(), 10) || 0;
                const assists = parseInt($(cols[6]).text().trim(), 10) || 0;
                const minutes = parseInt($(cols[7]).text().trim(), 10) || 0;

                const stat: PlayerStat = {
                    game_id: gameId,
                    team_id: teamName, // Use inferred team name
                    player_name: playerName,
                    player_key: playerKey,
                    jersey_number: jerseyNumber || null,

                    // Populate convenience fields
                    minutes,
                    goals,
                    assists,
                    shots,

                    // Dynamic stats map
                    stats: {
                        position: $(cols[0]).text().trim(),
                        shots_on_goal: sog,
                        saves: null,
                        goals_allowed: null,
                        started: section === null ? null : section === 'starters' ? 1 : 0
                    }
                };

                playerStats.push(stat);
            });
        });

        if (sawKeeperTable) applyKeepers(playerStats, keepers, gameId);

        if (playerStats.length === 0) {
            // Fallback to Nuxt parsing
            return this.parseNuxt(html, gameId);
        }

        return {
            game: {},
            playerStats
        };
    }

    /**
     * Column names a Sidearm player table uses, mapped onto what they mean.
     *
     * Sites abbreviate inconsistently and drop columns they have no data for, so the
     * position of a statistic is not fixed and its absence is normal. Reading the header
     * row makes both survivable.
     */
    private static readonly PLAYER_COLUMNS: Record<string, string[]> = {
        position: ['pos', 'pos.', 'position'],
        jersey: ['#', 'no', 'no.', 'number'],
        player: ['player', 'name', 'athlete', 'goalie', 'goalkeeper'],
        shots: ['sh', 'shots', 'sh.'],
        shots_on_goal: ['sog', 'sh att-og', 'shots on goal', 'so g'],
        goals: ['g', 'goals'],
        assists: ['a', 'assists', 'ast'],
        minutes: ['min', 'min.', 'minutes', 'mp'],
        goals_allowed: ['ga', 'goals against', 'goals allowed'],
        saves: ['saves', 'sv', 'sv.', 'svs']
    };

    /**
     * Player rows from tables that say what they are.
     *
     * A caption of "ELON - Player Stats" identifies both the table and the squad in it,
     * which is stronger evidence than the column count the positional reader relies on —
     * and it keeps a "Team Statistics" table, which is also eight columns wide, from being
     * read as a roster.
     *
     * "ELON - Goalie Statistics" is the same squad's goalkeeping, published as its own
     * table: minutes, goals allowed and saves for each keeper who played. It is the only
     * place a Sidearm page of this layout reports saves, so it is read and folded into the
     * player rows rather than skipped for not saying "Player Stats".
     */
    private parseCaptionedTables($: cheerio.CheerioAPI, gameId: string): PlayerStat[] {
        const stats: PlayerStat[] = [];
        const keepers: KeeperRow[] = [];
        let sawKeeperTable = false;
        let lastTeam: string | null = null;

        $('table').each((_, table) => {
            const caption = $(table).find('caption').text().replace(/\s+/g, ' ').trim();
            const isPlayers = /player\s*stat/i.test(caption);
            const isKeepers = /(goalie|goalkeep|keeper)/i.test(caption);
            if (!isPlayers && !isKeepers) return;

            // "W&M - Player Stats" -> "W&M". The team is whatever precedes the dash; a
            // caption without one names no squad and is left to the positional reader.
            const dash = caption.search(/\s[-–—]\s/);
            const teamName = dash === -1 ? '' : caption.slice(0, dash).trim();
            if (!teamName) return;

            const headers = $(table)
                .find('thead th, tr:first-child th')
                .map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim().toLowerCase())
                .get();
            if (headers.length === 0) return;

            const columnOf = (field: string): number => {
                const names = SidearmBoxScoreParser.PLAYER_COLUMNS[field];
                return headers.findIndex(header => names.includes(header));
            };
            const at = {
                position: columnOf('position'),
                jersey: columnOf('jersey'),
                player: columnOf('player'),
                shots: columnOf('shots'),
                shots_on_goal: columnOf('shots_on_goal'),
                goals: columnOf('goals'),
                assists: columnOf('assists'),
                minutes: columnOf('minutes'),
                goals_allowed: columnOf('goals_allowed'),
                saves: columnOf('saves')
            };
            // Without a name column there is no player to record, whatever else is there.
            if (at.player === -1) return;
            if (isKeepers && at.saves === -1 && at.goals_allowed === -1) return;

            let section: 'starters' | 'substitutes' | null = null;
            $(table)
                .find('tbody tr')
                .each((__, row) => {
                    const cells = $(row).find('td');
                    const label = sectionOf($(row).text());
                    if (label) {
                        section = label;
                        return;
                    }
                    if (cells.length <= at.player) return;

                    const text = (index: number) => (index === -1 ? '' : $(cells[index]).text().trim());
                    const number = (index: number) => {
                        const parsed = parseInt(text(index), 10);
                        return Number.isFinite(parsed) ? parsed : 0;
                    };
                    // A keeper's column that is there but empty is unreported, not zero.
                    const reported = (index: number): number | null => {
                        if (index === -1) return null;
                        const parsed = parseInt(text(index), 10);
                        return Number.isFinite(parsed) ? parsed : null;
                    };

                    const playerName = this.normalizePlayerName(text(at.player));
                    // Sidearm closes these tables with "Totals" and "TM TEAM" rows, which
                    // are the table's own arithmetic rather than anyone who played.
                    if (!playerName || /^(totals?|tm team|team)$/i.test(playerName)) return;

                    const normalised = letters(playerName);
                    if (!normalised) return;

                    if (isKeepers) {
                        keepers.push({
                            team: lastTeam,
                            name: playerName,
                            jersey: text(at.jersey) || null,
                            minutes: at.minutes === -1 ? null : Math.round(this.parseMinutes(text(at.minutes))),
                            goalsAllowed: reported(at.goals_allowed),
                            saves: reported(at.saves)
                        });
                        return;
                    }

                    stats.push({
                        game_id: gameId,
                        team_id: teamName,
                        player_name: playerName,
                        player_key: `${letters(teamName)}:${normalised}`,
                        jersey_number: text(at.jersey) || null,
                        // Absent, not zero: a table without a minutes column says nothing
                        // about how long anyone played, and recording that as 0 would put
                        // every one of these players on the bench.
                        minutes: at.minutes === -1 ? null : number(at.minutes),
                        goals: number(at.goals),
                        assists: number(at.assists),
                        shots: number(at.shots),
                        stats: {
                            position: text(at.position),
                            shots_on_goal: number(at.shots_on_goal),
                            saves: null,
                            goals_allowed: null,
                            started: section === null ? null : section === 'starters' ? 1 : 0
                        }
                    } as PlayerStat);
                });
            if (isKeepers) sawKeeperTable = true;
            else lastTeam = teamName;
        });

        // A goalkeeping table alone is not this layout: without a captioned player table
        // the page belongs to another reader, which reads its keepers itself.
        if (stats.length === 0) return [];
        if (sawKeeperTable) applyKeepers(stats, keepers, gameId);
        return stats;
    }

    private parseAdvancedTables($: cheerio.CheerioAPI, gameId: string): PlayerStat[] {
        const playerStats: PlayerStat[] = [];
        const keepers: KeeperRow[] = [];
        let sawKeeperTable = false;

        $('table.advanced-table__table').each((_, table) => {
            const headerText = $(table).find('thead th').first().text().trim();
            const teamName = headerText.split('-')[0].trim() || 'Unknown';

            const rows = $(table).find('tbody tr');
            // The first row with more than a label in it sets the table's width; a
            // "Starters" row ahead of it is one cell wide.
            const firstBodyRow = rows.filter((__, row) => $(row).find('td').length > 1).first();
            const colCount = firstBodyRow.find('td').length;
            if (colCount === 0) return;

            const isGoalkeeping = colCount === 6; // [Pos, #, Player, Minutes, GA, Saves]
            if (isGoalkeeping) sawKeeperTable = true;
            let section: 'starters' | 'substitutes' | null = null;

            rows.each((__, row) => {
                const cells = $(row).find('td');
                const label = sectionOf($(row).text());
                if (label) {
                    section = label;
                    return;
                }
                if (cells.length !== colCount) return;

                const position = $(cells[0]).text().trim();
                const jersey = $(cells[1]).text().trim();
                const playerNameRaw = $(cells[2]).text().trim();
                const playerName = this.normalizePlayerName(playerNameRaw);
                if (!playerName) return;

                const playerKey = `${letters(teamName)}:${letters(playerName)}`;

                if (isGoalkeeping) {
                    const reported = (text: string) => {
                        const parsed = parseInt(text.trim(), 10);
                        return Number.isFinite(parsed) ? parsed : null;
                    };
                    keepers.push({
                        team: teamName,
                        name: playerName,
                        jersey: jersey || null,
                        minutes: Math.round(this.parseMinutes($(cells[3]).text())),
                        goalsAllowed: reported($(cells[4]).text()),
                        saves: reported($(cells[5]).text())
                    });
                } else {
                    const shots = parseInt($(cells[3]).text().trim(), 10) || 0;
                    const sog = parseInt($(cells[4]).text().trim(), 10) || 0;
                    const goals = parseInt($(cells[5]).text().trim(), 10) || 0;
                    const assists = parseInt($(cells[6]).text().trim(), 10) || 0;
                    const minutes = this.parseMinutes($(cells[7]).text());

                    playerStats.push({
                        game_id: gameId,
                        team_id: teamName,
                        player_name: playerName,
                        player_key: playerKey,
                        jersey_number: jersey || null,
                        minutes,
                        goals,
                        assists,
                        shots,
                        stats: {
                            position,
                            shots_on_goal: sog,
                            saves: null,
                            goals_allowed: null,
                            started: section === null ? null : section === 'starters' ? 1 : 0
                        }
                    });
                }
            });
        });

        // A keeper used to come out of this reader twice, once from each table, and the
        // loader kept whichever came last — the goalkeeping row, with no shots or goals.
        if (sawKeeperTable) applyKeepers(playerStats, keepers, gameId);
        return playerStats;
    }

    private parseNuxt(html: string, gameId: string): ParseResult {
        const playerStats: PlayerStat[] = [];

        // Extract script content
        const $ = cheerio.load(html);
        const scriptContent = $('#__NUXT_DATA__').html();
        if (!scriptContent) {
            return { game: {}, playerStats: [] };
        }

        try {
            const data = JSON.parse(scriptContent);
            if (!Array.isArray(data)) return { game: {}, playerStats: [] };

            // Helper to resolve values from Nuxt compressed array
            const resolve = (val: any): any => {
                if (typeof val === 'number' && val < data.length) {
                    return resolve(data[val]);
                }
                return val;
            };

            // Helper to get object keys/values without deep resolution if it's just an index reference
            // But we need to check if an object IS a team.
            // A team object has 'players', 'id', 'name'.

            // Scan for Team objects
            for (let i = 0; i < data.length; i++) {
                const item = data[i];
                if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                    // Check for team signature
                    if ('players' in item && 'id' in item && 'name' in item) {
                        // Resolve players array
                        let playersVal = item.players;
                        if (typeof playersVal === 'number') playersVal = data[playersVal]; // This gets the array (or index to array)
                        // If it points to an index that IS an array
                        if (typeof playersVal === 'number' && Array.isArray(data[playersVal])) {
                            playersVal = data[playersVal];
                        }

                        if (Array.isArray(playersVal)) {
                            // Valid team found
                            const teamName = String(resolve(item.name) || 'Unknown');
                            const teamId = String(resolve(item.id) || teamName);
                            // console.log(`Found team: ${teamName} (${teamId}) with ${playersVal.length} players`);

                            playersVal.forEach((playerIndex: any) => {
                                // Resolve player object
                                let playerObj = playerIndex;
                                if (typeof playerObj === 'number') playerObj = data[playerObj];

                                if (typeof playerObj === 'object' && playerObj) {
                                    // Extract stats
                                    const nameRaw = String(resolve(playerObj.name) || resolve(playerObj.playerFirstLastName) || 'Unknown');
                                    const name = this.normalizePlayerName(nameRaw);
                                    const jersey = String(resolve(playerObj.uniform) || '');
                                    const position = String(resolve(playerObj.position) || '');
                                    const playerId = String(resolve(playerObj.playerUrl) || name).split('/').pop() || name;

                                    // Minutes
                                    let minutes = parseInt(resolve(playerObj.minutesPlayed) || '0', 10);

                                    // Shots stats
                                    let goals = 0;
                                    let assists = 0;
                                    let shots = 0;
                                    let sog = 0;

                                    let shotsObj = playerObj.shots;
                                    if (typeof shotsObj === 'number') shotsObj = data[shotsObj];
                                    if (shotsObj) {
                                        goals = parseInt(resolve(shotsObj.goals) || '0', 10);
                                        assists = parseInt(resolve(shotsObj.assists) || '0', 10);
                                        shots = parseInt(resolve(shotsObj.numberOfShots) || '0', 10);
                                        sog = parseInt(resolve(shotsObj.shotsOnGoal) || '0', 10);
                                    }

                                    // Goalie stats. Only a player with a goalie record has
                                    // any: everyone else's are absent, not zero.
                                    let saves: number | null = null;
                                    let goalsAllowed: number | null = null;
                                    let goalieMinutes = 0;

                                    let goalieObj = playerObj.goalie;
                                    if (typeof goalieObj === 'number') goalieObj = data[goalieObj];
                                    if (goalieObj) {
                                        saves = parseInt(resolve(goalieObj.saves) || '0', 10);
                                        goalsAllowed = parseInt(resolve(goalieObj.goalsAllowed) || '0', 10);
                                        const gm = resolve(goalieObj.minutes); // might be "90:00"
                                        if (gm && typeof gm === 'string' && gm.includes(':')) {
                                            goalieMinutes = parseInt(gm.split(':')[0], 10);
                                        } else {
                                            goalieMinutes = parseInt(gm || '0', 10);
                                        }
                                    }

                                    // Use goalie minutes if player minutes is 0 and they are a goalie
                                    if (minutes === 0 && goalieMinutes > 0) minutes = goalieMinutes;

                                    const stat: PlayerStat = {
                                        game_id: gameId,
                                        team_id: teamName,
                                        player_name: name,
                                        player_key: `${teamName.toLowerCase().replace(/[^a-z0-9]/g, '')}:${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
                                        jersey_number: jersey,
                                        minutes,
                                        goals,
                                        assists,
                                        shots,
                                        stats: {
                                            position,
                                            shots_on_goal: sog,
                                            saves,
                                            goals_allowed: goalsAllowed,
                                            started: startedFlag(resolve(playerObj.gameStarted))
                                        }
                                    };

                                    playerStats.push(stat);
                                }
                            });
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to parse Nuxt data', e);
        }

        return {
            game: {},
            playerStats
        };
    }

    private extractGameId(url: string): string {
        const match = url.match(/\/(\d+)(?:$|\?)/);
        return match ? `sidearm-${match[1]}` : 'unknown'; // Align with schedule ID format
    }
}
