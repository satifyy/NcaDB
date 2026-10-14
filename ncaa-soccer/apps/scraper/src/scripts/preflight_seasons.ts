/**
 * Checks that the seasons about to be scraped are actually published, before a run that
 * takes hours is started against them.
 *
 * Historical coverage was only ever verified for 2025. All three platforms are supposed
 * to serve past seasons — WMT through its season API, Sidearm and WMT's WordPress
 * product at `/schedule/<year>` — but "supposed to" is what a backfill cannot afford to
 * assume: a school that quietly serves the current season for every requested year
 * produces a season file that looks full and is wrong, and the box-score stage behind it
 * is the long pole at roughly 75 minutes per season.
 *
 * So this samples a few schools per platform per season and reports what each returns. It
 * is cheap — a handful of requests per season, no browser — and is the gate the pipeline
 * runs before committing to a season.
 *
 * Usage:
 *   npx tsx apps/scraper/src/scripts/preflight_seasons.ts 2021 2022 2023 2024 2025
 *   npx tsx apps/scraper/src/scripts/preflight_seasons.ts --sample 5 2021
 *
 * Exits non-zero when a platform returns nothing for a season, which is the signal that
 * the season cannot be scraped through that platform and the run should not start.
 */

import { INVENTORY } from '@ncaa/storage';
import { loadTeams, TeamConfig } from '../utils/teams';
import { countSeasonEvents } from '../utils/season_probe';

const COMBINED = INVENTORY;
const PLATFORMS = ['sidearm', 'wmt', 'wmt_wp'] as const;

/** Schools per platform to sample. Enough to tell a dead platform from an odd school. */
const DEFAULT_SAMPLE = 3;

/**
 * A stable sample rather than a random one, so a failure can be reproduced and a
 * platform is not judged by a different school on every run.
 */
function sampleByPlatform(teams: TeamConfig[], perPlatform: number): Map<string, TeamConfig[]> {
    const byPlatform = new Map<string, TeamConfig[]>();
    for (const platform of PLATFORMS) {
        const candidates = teams
            .filter(team => team.platform_guess === platform && team.schedule_url)
            .sort((a, b) => a.name_canonical.localeCompare(b.name_canonical));
        byPlatform.set(platform, candidates.slice(0, perPlatform));
    }
    return byPlatform;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let perPlatform = DEFAULT_SAMPLE;
    const sampleAt = args.indexOf('--sample');
    if (sampleAt !== -1) {
        perPlatform = Number(args[sampleAt + 1]) || DEFAULT_SAMPLE;
        args.splice(sampleAt, 2);
    }

    const seasons = args.map(Number).filter(year => year > 1900);
    if (seasons.length === 0) {
        console.error('Usage: preflight_seasons.ts [--sample N] <season> [season...]');
        process.exit(1);
    }

    const teams = loadTeams(COMBINED);
    const sample = sampleByPlatform(teams, perPlatform);
    const dead: string[] = [];

    for (const season of seasons) {
        console.log(`\n=== ${season} ===`);
        for (const platform of PLATFORMS) {
            const schools = sample.get(platform) || [];
            if (schools.length === 0) {
                console.log(`  ${platform.padEnd(7)} no schools on this platform in the inventory`);
                continue;
            }

            const counts = await Promise.all(
                schools.map(async team => ({
                    team,
                    games: await countSeasonEvents(team.schedule_url, team.platform_guess, season)
                }))
            );

            const total = counts.reduce((sum, c) => sum + c.games, 0);
            const detail = counts.map(c => `${c.team.name_canonical}=${c.games}`).join(' ');
            const verdict = total === 0 ? 'NO DATA' : 'ok';
            console.log(`  ${platform.padEnd(7)} ${verdict.padEnd(8)} ${detail}`);
            if (total === 0) dead.push(`${season}/${platform}`);
        }
    }

    if (dead.length > 0) {
        console.error(
            `\n${dead.length} platform-season combination(s) returned nothing: ${dead.join(', ')}.` +
                `\nScraping these would write empty or wrong-season files. Investigate before running the backfill.`
        );
        process.exit(1);
    }
    console.log('\nAll sampled platforms serve every requested season.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
