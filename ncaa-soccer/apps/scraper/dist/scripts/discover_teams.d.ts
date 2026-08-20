/**
 * Builds the team inventory a scrape needs, given only conference rosters.
 *
 * The pipeline is driven by a teams JSON holding, per school, a men's soccer schedule
 * URL and which platform serves it. Writing that by hand does not scale past one
 * conference and goes stale as schools migrate between Sidearm and WMT, so this
 * derives it:
 *
 *   1. Harvest school -> athletics domain from schedule pages we can already reach.
 *      Sidearm renders each opponent as a link to that school's own site, and the WMT
 *      API carries `opponent.website_url`, so every scraped season hands us a batch of
 *      domains for free. Newly resolved schools are re-harvested, so coverage spreads.
 *   2. Probe each domain for a men's soccer schedule, trying the slugs the two
 *      platforms use and detecting the platform from the response.
 *   3. Verify the result actually yields games before writing it out.
 *
 * Usage:
 *   npx tsx apps/scraper/src/scripts/discover_teams.ts <rosters.json> [season] [outDir]
 *
 * `rosters.json` maps a conference name to its member schools:
 *   { "Big Ten": ["Indiana", "Maryland", ...], "Big East": [...] }
 */
import { TeamConfig } from '../utils/teams';
export interface DiscoveredTeam extends TeamConfig {
    conference: string;
    sport: 'msoc';
    aliases: string[];
    verified_games?: number;
}
//# sourceMappingURL=discover_teams.d.ts.map