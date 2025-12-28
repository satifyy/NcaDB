
import { ParseResult, ParserOptions } from '../types';
import { PlayerStat, PlayerStatSchema } from '@ncaa/shared';
import * as cheerio from 'cheerio';
// import { z } from 'zod'; // Not needed for HTML parsing unless we validate the final object

export class SidearmBoxScoreParser {

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

        // Find tables with class 'sidearm-table overall-stats' OR 'w-full'
        // Try multiple selectors to handle different Sidearm layouts
        let tables = $('table.sidearm-table.overall-stats');
        if (tables.length === 0) {
            tables = $('table.w-full');
        }
        if (tables.length === 0) {
            tables = $('table');
        }

        tables.each((i, table) => {
            const caption = $(table).find('caption').text().trim();
            // Heuristic to detect team from caption (e.g. "SMU - Player Stats")
            // We need to associate this with options.teamName or similar?
            // Actually, we should probably return stats with "team_name" field populated from the caption or context.

            // For now, let's assume we can pass the team names in options or infer them.
            // But wait, the shared PlayerStat schema needs `team_id` or `team_name`.

            let teamName = 'Unknown';
            if (caption) {
                teamName = caption.split('-')[0].trim();
            }

            const rows = $(table).find('tbody tr');
            rows.each((j, row) => {
                const cols = $(row).find('td');
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
                const playerName = playerCell.text().trim();
                // Extract Player ID from link? e.g. /sports/mens-soccer/roster/bailey-sparks/1234
                const playerLink = playerCell.find('a').attr('href');
                let playerId = playerName.replace(/\s+/g, '-').toLowerCase(); // fallback
                if (playerLink) {
                    const parts = playerLink.split('/');
                    const potentialId = parts[parts.length - 1];
                    if (potentialId && !isNaN(Number(potentialId))) {
                        playerId = `sidearm-${potentialId}`;
                    }
                }

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
                        shots_on_goal: sog,
                        saves: 0
                    }
                };

                // Validate against schema?
                // const valid = PlayerStatSchema.safeParse(stat);
                // if (valid.success) playerStats.push(valid.data);

                playerStats.push(stat);
            });
        });

        if (playerStats.length === 0) {
            // Fallback to Nuxt parsing
            return this.parseNuxt(html, gameId);
        }

        return {
            game: {},
            playerStats
        };
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
                                    const name = String(resolve(playerObj.name) || resolve(playerObj.playerFirstLastName) || 'Unknown');
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

                                    // Goalie stats
                                    let saves = 0;
                                    let goalsAllowed = 0;
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
                                            goals_allowed: goalsAllowed
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
