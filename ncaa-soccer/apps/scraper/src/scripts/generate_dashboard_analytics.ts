/**
 * Copies the ratings, forecasts and impact scores into the shapes the dashboard loads.
 *
 * `build_ratings.ts` and `build_predictions.ts` write for analysis: full precision, every
 * player, CSV where CSV is the useful form. A browser wants none of that. This stage is
 * the boundary between them — it rounds, drops the columns nothing renders, and splits
 * per season so the page fetches one year rather than eleven.
 *
 * The split is the whole point. Eleven seasons of predictions and impact together are
 * some 20 MB; the index is 30 KB and holds everything the controls need, so the page can
 * render its navigation, its coverage notice and its accuracy figures before a single
 * season has been requested.
 *
 * Usage:
 *   npx tsx apps/scraper/src/scripts/generate_dashboard_analytics.ts
 *
 * Run after `build_ratings.ts` and `build_predictions.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    COVERAGE_PATH,
    dec,
    flag,
    ImpactCsvRow,
    impactCsv,
    int,
    PREDICTIONS_DIR,
    RATINGS_DIR,
    readAllIfExists,
    REPO_ROOT
} from '@ncaa/storage';

const OUT_DIR = path.join(REPO_ROOT, 'apps/dashboard/src/data/analytics');

/** Rounds for the wire: three decimals is finer than any of this is rendered at. */
const round = (value: number, places = 3): number => {
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
};

function read<T>(file: string, what: string): T {
    if (!fs.existsSync(file)) {
        console.error(`Missing ${what}: ${file}`);
        console.error('Run build_ratings.ts and build_predictions.ts first.');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function write(name: string, value: unknown): void {
    const target = path.join(OUT_DIR, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
    const kb = (fs.statSync(target).size / 1024).toFixed(0);
    console.log(`  ${name.padEnd(34)} ${kb.padStart(6)} KB`);
}

/**
 * Impact rows, trimmed to the players a leaderboard can meaningfully rank.
 *
 * A season's file holds around 8,000 players, of whom some 4,000 never reached a
 * qualifying number of minutes and several hundred never left the bench. Shipping all of
 * them triples the file so that a table can offer rows nobody can sort by. Anyone who
 * played at all is kept; the flag says who is ranked.
 */
const MINIMUM_MINUTES = 90;

function seasonImpact(season: string): unknown[] {
    const rows = readAllIfExists<ImpactCsvRow>(impactCsv(season));

    return rows
        .filter(row => dec(row.minutes) >= MINIMUM_MINUTES)
        .map(row => ({
            id: row.identity,
            name: row.player_name,
            team: row.team,
            conference: row.conference,
            jersey: row.jersey_number,
            games: int(row.games),
            minutes: int(row.minutes),
            goals: int(row.goals),
            assists: int(row.assists),
            shots: int(row.shots),
            sog: int(row.shots_on_goal),
            saves: int(row.saves),
            ga: round(dec(row.goals_against), 1),
            keeper: flag(row.is_keeper),
            keeper_games: int(row.keeper_games),
            impact: round(dec(row.impact), 2),
            per90: round(dec(row.impact_per90), 3),
            opponents: dec(row.opponent_strength),
            rating: dec(row.rating),
            qualified: flag(row.qualified),
            d1: flag(row.division_one)
        }))
        .sort((a, b) => b.impact - a.impact);
}

interface PredictionFile {
    season: string;
    weeks: {
        week: string;
        status: string;
        games: Record<string, unknown>[];
        accuracy: unknown;
    }[];
    accuracy: unknown;
}

/** Predictions, rounded and with the fields no card renders removed. */
function seasonPredictions(season: string): unknown | null {
    const file = path.join(PREDICTIONS_DIR, `${season}.json`);
    if (!fs.existsSync(file)) return null;
    const source: PredictionFile = JSON.parse(fs.readFileSync(file, 'utf8'));

    return {
        season: source.season,
        accuracy: source.accuracy,
        weeks: source.weeks.map(week => ({
            week: week.week,
            status: week.status,
            accuracy: week.accuracy,
            games: week.games.map(game => ({
                id: game.game_id,
                date: game.date,
                home: game.home,
                away: game.away,
                home_conference: game.home_conference,
                away_conference: game.away_conference,
                neutral: game.neutral,
                home_elo: game.home_elo,
                away_elo: game.away_elo,
                p: [
                    round(game.p_home as number),
                    round(game.p_draw as number),
                    round(game.p_away as number)
                ],
                xg: [round(game.exp_home_goals as number, 2), round(game.exp_away_goals as number, 2)],
                scorelines: (game.scorelines as { score: string; probability: number }[]).map(line => ({
                    score: line.score,
                    p: round(line.probability)
                })),
                confidence: round(game.confidence as number),
                pick: game.pick,
                home_score: game.home_score,
                away_score: game.away_score,
                outcome: game.outcome,
                correct: game.correct,
                upset: game.upset
            }))
        }))
    };
}

function main(): void {
    const coverage = read<{ seasons: Record<string, unknown>[] }>(COVERAGE_PATH, 'season coverage');
    const ratings = read<{ current_season: string; seasons: string[]; teams: Record<string, unknown>[] }>(
        path.join(RATINGS_DIR, 'team_ratings.json'),
        'team ratings'
    );
    const model = read<Record<string, unknown>>(path.join(RATINGS_DIR, 'model.json'), 'the fitted model');
    const standouts = read<{ weeks: Record<string, unknown>[] }>(
        path.join(RATINGS_DIR, 'standouts.json'),
        'weekly standouts'
    );
    const predictionIndex = read<Record<string, unknown>>(
        path.join(PREDICTIONS_DIR, 'index.json'),
        'the prediction index'
    );
    const timeline = read<{ teams: { team: string; points: [string, number][] }[] }>(
        path.join(RATINGS_DIR, 'elo_timeline.json'),
        'the Elo timeline'
    );

    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`Writing to ${OUT_DIR}`);

    write('index.json', {
        generated_at: new Date().toISOString(),
        current_season: ratings.current_season,
        current_week: predictionIndex.current_week,
        seasons: ratings.seasons,
        coverage: coverage.seasons,
        model: {
            elo: (model as { elo: unknown }).elo,
            outcome: (model as { outcome: unknown }).outcome,
            goals: (model as { goals: unknown }).goals,
            returning_production_weight: (model as { returning_production_weight: unknown })
                .returning_production_weight,
            fitted_on: (model as { fitted_on: unknown }).fitted_on,
            held_out: (model as { held_out: unknown }).held_out,
            performance: (model as { performance: unknown }).performance
        },
        prediction_record: {
            overall: predictionIndex.overall,
            by_season: predictionIndex.by_season
        }
    });

    write('ratings.json', { current_season: ratings.current_season, teams: ratings.teams });

    // The timeline is only ever drawn for a handful of selected teams, but which handful
    // is the reader's choice, so all of them ship — in one lazily fetched file.
    write('elo_timeline.json', timeline);

    write('standouts.json', { weeks: standouts.weeks });

    for (const season of ratings.seasons) {
        const impact = seasonImpact(season);
        if (impact.length > 0) write(`impact/${season}.json`, { season, players: impact });

        const predictions = seasonPredictions(season);
        if (predictions) write(`predictions/${season}.json`, predictions);
    }

    console.log('\nDone.');
}

main();
