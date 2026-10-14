/**
 * Adds the `game_type` column to every stored season, offline.
 *
 * The fixture markers this reads were never fetched twice — they are still in the rows on
 * disk. The pipeline cleans the team-name columns but builds `game_id` and `dedupe_key`
 * from the names as the site published them, so "Marist (Exhibition)" survives in the id
 * of a row whose name column now reads "Marist". Across the eleven stored seasons the
 * marker sits in an id about 460 times and in a name column about 40, which is why the
 * exhibition flag `matches.ts` derives from the name columns has been catching under a
 * tenth of them, and why `learnAliases` — which documents its dependence on that flag —
 * has been running without it.
 *
 * Recomputing beats trusting: the column is derived, so a re-run after the classifier
 * changes should produce the new answer rather than preserving the old one. The one thing
 * it will not overwrite is a non-`regular` value already stored, since that may have come
 * from WMT's structured `is_exhibition`, which leaves no trace in the text.
 *
 *   npx tsx apps/scraper/src/scripts/backfill_game_type.ts [--dry-run] [--season 2025]
 */

import * as fs from 'fs';
import { classifyGameType, GameType, GameTypeEvidence, isGameType } from '@ncaa/parsers';
import {
    GameCsvRow,
    GAMES_DIR,
    gamesCsv,
    headerFrom,
    readAllIfExists,
    writeRows
} from '@ncaa/storage';

interface SeasonReport {
    season: string;
    rows: number;
    byType: Record<GameType, number>;
    byEvidence: Record<GameTypeEvidence, number>;
    changed: number;
}

const EMPTY_TYPES = (): Record<GameType, number> => ({
    exhibition: 0,
    ncaa_tournament: 0,
    conference_tournament: 0,
    regular: 0
});

const EMPTY_EVIDENCE = (): Record<GameTypeEvidence, number> => ({
    flag: 0,
    marker: 0,
    date: 0,
    default: 0
});

/**
 * Column order for the rewritten file.
 *
 * Taken from the header the season already has rather than from a constant, so a file
 * with an extra column keeps it, and `game_type` is appended rather than inserted — a
 * reader that indexes by position sees every existing column exactly where it was.
 */
const headerFor = (rows: GameCsvRow[]): string[] => headerFrom(rows, ['game_type']);

function backfillSeason(season: string, dryRun: boolean): SeasonReport | null {
    const csvPath = gamesCsv(season);
    if (!fs.existsSync(csvPath)) return null;

    const rows = readAllIfExists<GameCsvRow>(csvPath);

    const report: SeasonReport = {
        season,
        rows: rows.length,
        byType: EMPTY_TYPES(),
        byEvidence: EMPTY_EVIDENCE(),
        changed: 0
    };

    for (const row of rows) {
        const stored = row.game_type;
        const derived = classifyGameType(row);

        // A stored non-`regular` value outranks a freshly derived one only when the
        // derivation found nothing: the text markers are reproducible, WMT's flag is not.
        const keepStored = isGameType(stored) && stored !== 'regular' && derived.type === 'regular';
        const type = keepStored ? (stored as GameType) : derived.type;
        const evidence = keepStored ? 'flag' : derived.evidence;

        if (row.game_type !== type) report.changed++;
        row.game_type = type;
        report.byType[type]++;
        report.byEvidence[evidence]++;
    }

    if (!dryRun) writeRows(csvPath, rows, headerFor(rows));

    return report;
}

function main(): void {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const seasonArg = args.indexOf('--season');
    const only = seasonArg >= 0 ? args[seasonArg + 1] : null;

    if (!fs.existsSync(GAMES_DIR)) {
        console.error(`No games directory at ${GAMES_DIR}`);
        process.exit(1);
    }

    const seasons = fs
        .readdirSync(GAMES_DIR)
        .filter(name => /^\d{4}$/.test(name))
        .filter(name => !only || name === only)
        .sort();

    if (seasons.length === 0) {
        console.error(only ? `No season ${only}` : `No seasons under ${GAMES_DIR}`);
        process.exit(1);
    }

    const totals = { rows: 0, byType: EMPTY_TYPES(), byEvidence: EMPTY_EVIDENCE(), changed: 0 };
    console.log(dryRun ? 'Dry run — nothing will be written.\n' : '');
    console.log('season   rows   exhib   ncaa   conf   regular   changed');

    for (const season of seasons) {
        const report = backfillSeason(season, dryRun);
        if (!report) continue;
        totals.rows += report.rows;
        totals.changed += report.changed;
        for (const type of Object.keys(report.byType) as GameType[]) {
            totals.byType[type] += report.byType[type];
        }
        for (const evidence of Object.keys(report.byEvidence) as GameTypeEvidence[]) {
            totals.byEvidence[evidence] += report.byEvidence[evidence];
        }
        console.log(
            `${season}   ${String(report.rows).padStart(4)}   ${String(report.byType.exhibition).padStart(5)}` +
                `   ${String(report.byType.ncaa_tournament).padStart(4)}` +
                `   ${String(report.byType.conference_tournament).padStart(4)}` +
                `   ${String(report.byType.regular).padStart(7)}` +
                `   ${String(report.changed).padStart(7)}`
        );
    }

    console.log(
        `\ntotal    ${String(totals.rows).padStart(4)}   ${String(totals.byType.exhibition).padStart(5)}` +
            `   ${String(totals.byType.ncaa_tournament).padStart(4)}` +
            `   ${String(totals.byType.conference_tournament).padStart(4)}` +
            `   ${String(totals.byType.regular).padStart(7)}` +
            `   ${String(totals.changed).padStart(7)}`
    );

    // Printed rather than left implicit: `regular` here is "nothing said otherwise", and
    // the split between a stated marker and a calendar guess is the whole reason to trust
    // the exhibition count more than the postseason one.
    console.log(
        `\nevidence: flag=${totals.byEvidence.flag} marker=${totals.byEvidence.marker} ` +
            `date=${totals.byEvidence.date} default=${totals.byEvidence.default}`
    );
    console.log(
        'Postseason labels are a floor, not a census: most bracket games carry no round\n' +
            'marker at all, and `regular` means only that nothing on the row said otherwise.'
    );
}

main();
