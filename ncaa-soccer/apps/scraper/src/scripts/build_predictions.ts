/**
 * The week-by-week predictor.
 *
 * A season is forecast the way it is actually played: in weeks. Ratings are frozen at the
 * start of each week, every fixture in that week is predicted from the frozen ratings, and
 * only then are the week's results applied. That is not a detail of implementation — it is
 * what makes the record honest. Predicting a Sunday game from ratings that already include
 * Friday's result would produce a hit rate no forecast could have achieved in advance, and
 * a "72% accurate" banner that quietly means nothing.
 *
 * The same loop runs over the whole dataset, so every past week carries the prediction it
 * would have been given at the time along with what happened, and the accuracy shown next
 * to this week's fixtures is measured on exactly the same procedure that produced them.
 *
 * The models come from `build_ratings.ts` and are not refitted here; this script only
 * applies them. Run it after that one.
 *
 * Usage:
 *   npx tsx apps/scraper/src/scripts/build_predictions.ts
 *   npx tsx apps/scraper/src/scripts/build_predictions.ts --season 2026
 */

import * as fs from 'fs';
import * as path from 'path';
import { COVERAGE_PATH, PREDICTIONS_DIR, RATINGS_DIR } from '@ncaa/storage';
import {
    INVENTORY,
    UNAFFILIATED,
    buildTeamIndex,
    canonicalTeamNames,
    makeTeamResolver,
    seasonsOnDisk,
    gameSeasonsOnDisk
} from '../utils/canonical_teams';
import { loadTeams } from '../utils/teams';
import { loadMatches, Match, outcomeOf, weekOf, Outcome } from '../analytics/matches';
import { EloEngine, EloParams, BASELINE } from '../analytics/elo';
import {
    OutcomeParams,
    GoalsParams,
    Probabilities,
    probabilities,
    expectedGoals,
    scorelines,
    eraOf,
    Scoreline
} from '../analytics/outcome';


interface Model {
    elo: EloParams;
    outcome: OutcomeParams;
    goals: GoalsParams;
    returning_production_weight: number;
    fitted_on: string[];
    held_out: string[];
    performance: unknown;
}

interface Prediction {
    game_id: string;
    date: string;
    home: string;
    away: string;
    home_conference: string;
    away_conference: string;
    neutral: boolean;
    home_elo: number;
    away_elo: number;
    /** Home win, draw, away win. */
    p_home: number;
    p_draw: number;
    p_away: number;
    exp_home_goals: number;
    exp_away_goals: number;
    /** The likeliest scorelines, consistent with the three probabilities. */
    scorelines: { score: string; probability: number }[];
    /** How far from a coin flip the pick is — what "confident" means on the page. */
    confidence: number;
    pick: 'home' | 'draw' | 'away';
    /** Null until the game is played. */
    home_score: number | null;
    away_score: number | null;
    outcome: 'home' | 'draw' | 'away' | null;
    correct: boolean | null;
    /** Negative log likelihood the model paid for this game. */
    loss: number | null;
    /** Games where the underdog by 100+ rating points won. */
    upset: boolean;
}

interface WeekAccuracy {
    games: number;
    correct: number;
    accuracy: number;
    log_loss: number;
    /**
     * What a forecast knowing only how often each outcome happens would have paid.
     *
     * The bar the model has to clear, computed from the same games rather than from the
     * whole dataset — a season with more draws is harder, and holding every season against
     * one number would credit the model for the easy ones.
     */
    baseline_log_loss: number;
}

interface PredictedWeek {
    week: string;
    /** `played` once every fixture has a result; `live` while some do not. */
    status: 'played' | 'partial' | 'upcoming';
    games: Prediction[];
    accuracy: WeekAccuracy | null;
}

const NAMES = ['home', 'draw', 'away'] as const;

function read<T>(file: string): T {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Groups matches into the weeks they were played in, oldest first. */
function byWeek(matches: Match[]): Map<string, Match[]> {
    const weeks = new Map<string, Match[]>();
    for (const match of matches) {
        const list = weeks.get(match.week) || [];
        list.push(match);
        weeks.set(match.week, list);
    }
    return new Map([...weeks].sort((a, b) => a[0].localeCompare(b[0])));
}

function accuracyOf(games: Prediction[]): WeekAccuracy | null {
    const settled = games.filter(game => game.correct !== null);
    if (settled.length === 0) return null;
    const correct = settled.filter(game => game.correct).length;

    const counts = { home: 0, draw: 0, away: 0 };
    for (const game of settled) counts[game.outcome!]++;
    const baseline =
        settled.reduce(
            (total, game) => total - Math.log(Math.max(counts[game.outcome!] / settled.length, 1e-12)),
            0
        ) / settled.length;

    return {
        games: settled.length,
        correct,
        accuracy: correct / settled.length,
        log_loss: settled.reduce((total, game) => total + (game.loss ?? 0), 0) / settled.length,
        baseline_log_loss: baseline
    };
}

/** A rating gap this large makes the other side an underdog worth calling an upset. */
const UPSET_GAP = 100;

function main(): void {
    const modelPath = path.join(RATINGS_DIR, 'model.json');
    if (!fs.existsSync(modelPath)) {
        console.error(`No fitted model at ${modelPath}. Run build_ratings.ts first.`);
        process.exit(1);
    }
    const model = read<Model>(modelPath);
    const coverage = read<{ seasons: { season: string; usable: boolean }[] }>(COVERAGE_PATH);
    const usable = coverage.seasons.filter(season => season.usable).map(season => season.season);

    const teams = buildTeamIndex();
    const canonical = canonicalTeamNames(seasonsOnDisk(), teams);
    const resolveTeam = makeTeamResolver(canonical, teams);
    const conferenceOf = (team: string) => teams.find(team)?.conference || UNAFFILIATED;
    const ratedTeams = new Set(loadTeams(INVENTORY).map(team => team.name_canonical));

    const matches = loadMatches(gameSeasonsOnDisk(), resolveTeam, ratedTeams).filter(match =>
        usable.includes(match.season)
    );

    // The roster term is only ever applied through the engine, and the engine takes it as
    // a map. It is empty when the fit decided the term did not earn its place.
    const engine = new EloEngine({ ...model.elo }, ratedTeams);

    const requested = process.argv.includes('--season')
        ? process.argv[process.argv.indexOf('--season') + 1]
        : undefined;
    const currentSeason = requested && usable.includes(requested) ? requested : usable[usable.length - 1];

    const bySeason = new Map<string, PredictedWeek[]>();
    for (const season of usable) bySeason.set(season, []);

    let totalGames = 0;
    let totalCorrect = 0;
    let totalLoss = 0;

    for (const [week, played] of byWeek(matches)) {
        const season = played[0].season;
        const era = eraOf(season);

        // Ratings are read for the whole week before any of it is applied, so a Sunday
        // fixture is forecast without the benefit of Friday's result.
        const forecasts: Prediction[] = played.map(match => {
            const homeElo = engine.rating(match.home);
            const awayElo = engine.rating(match.away);
            const eloDiff = engine.diff(match.home, match.away, match.neutral);
            const p: Probabilities = probabilities(eloDiff, era, model.outcome);
            const mu = expectedGoals(homeElo - awayElo, match.neutral, model.goals);
            const lines: Scoreline[] = scorelines(mu, p);

            const outcome = outcomeOf(match);
            const pickIndex = p.indexOf(Math.max(...p)) as Outcome;
            const sorted = [...p].sort((a, b) => b - a);

            return {
                game_id: match.game_id,
                date: match.date,
                home: match.home,
                away: match.away,
                home_conference: conferenceOf(match.home),
                away_conference: conferenceOf(match.away),
                neutral: match.neutral,
                home_elo: Math.round(homeElo),
                away_elo: Math.round(awayElo),
                p_home: p[0],
                p_draw: p[1],
                p_away: p[2],
                exp_home_goals: mu.home,
                exp_away_goals: mu.away,
                scorelines: lines.map(line => ({
                    score: `${line.home}-${line.away}`,
                    probability: line.probability
                })),
                confidence: sorted[0] - sorted[1],
                pick: NAMES[pickIndex],
                home_score: match.home_score,
                away_score: match.away_score,
                outcome: outcome === null ? null : NAMES[outcome],
                correct: outcome === null ? null : outcome === pickIndex,
                loss: outcome === null ? null : -Math.log(Math.max(p[outcome], 1e-12)),
                upset:
                    outcome === null
                        ? false
                        : Math.abs(eloDiff) >= UPSET_GAP &&
                          ((eloDiff > 0 && outcome === 2) || (eloDiff < 0 && outcome === 0))
            };
        });

        for (const forecast of forecasts) {
            if (forecast.correct === null) continue;
            totalGames++;
            if (forecast.correct) totalCorrect++;
            totalLoss += forecast.loss ?? 0;
        }

        // Now the week counts: apply its results and move the ratings on.
        for (const match of played) if (match.played) engine.apply(match);

        const settled = forecasts.filter(f => f.outcome !== null).length;
        bySeason.get(season)!.push({
            week,
            status: settled === 0 ? 'upcoming' : settled === forecasts.length ? 'played' : 'partial',
            games: forecasts.sort(
                (a, b) => a.date.localeCompare(b.date) || b.home_elo + b.away_elo - (a.home_elo + a.away_elo)
            ),
            accuracy: accuracyOf(forecasts)
        });
    }

    fs.mkdirSync(PREDICTIONS_DIR, { recursive: true });

    const seasonSummaries: Record<string, WeekAccuracy | null> = {};
    for (const [season, weeks] of bySeason) {
        if (weeks.length === 0) continue;
        const games = weeks.flatMap(week => week.games);
        seasonSummaries[season] = accuracyOf(games);
        fs.writeFileSync(
            path.join(PREDICTIONS_DIR, `${season}.json`),
            // No timestamp in here: a completed season's forecasts do not change, and a
            // build stamp would rewrite a megabyte of identical JSON on every run. The
            // index carries the stamp for the whole set.
            `${JSON.stringify({ season, weeks, accuracy: seasonSummaries[season] })}\n`
        );
    }

    // The week a reader arrives on is the one containing today, not the first one with
    // no result: a preseason exhibition that never had a score published would otherwise
    // open the page on a week three months gone.
    const today = new Date().toISOString().slice(0, 10);
    const currentWeeks = bySeason.get(currentSeason) || [];
    const currentWeek =
        currentWeeks.find(week => weekOf(today) === week.week)?.week ??
        currentWeeks.find(week => week.week >= weekOf(today))?.week ??
        currentWeeks[currentWeeks.length - 1]?.week ??
        null;

    const index = {
        generated_at: new Date().toISOString(),
        current_season: currentSeason,
        current_week: currentWeek,
        seasons: usable,
        fitted_on: model.fitted_on,
        held_out: model.held_out,
        by_season: seasonSummaries,
        // Zeroed rather than null when nothing has been played: the site reads this on
        // arrival, and a missing record is a crash rather than an empty one.
        overall: accuracyOf([...bySeason.values()].flatMap(weeks => weeks.flatMap(week => week.games))) ?? {
            games: 0,
            correct: 0,
            accuracy: 0,
            log_loss: 0,
            baseline_log_loss: 0
        },
        performance: model.performance
    };
    fs.writeFileSync(path.join(PREDICTIONS_DIR, 'index.json'), `${JSON.stringify(index, null, 4)}\n`);

    console.log(`Predicted ${totalGames} settled fixtures across ${usable.length} season(s).`);
    for (const [season, summary] of Object.entries(seasonSummaries)) {
        if (!summary) continue;
        console.log(
            `  ${season}  ${summary.games} games  ${(summary.accuracy * 100).toFixed(1)}% correct  ` +
                `log loss ${summary.log_loss.toFixed(4)}`
        );
    }
    console.log(
        `  all    ${totalGames} games  ${((totalCorrect / Math.max(totalGames, 1)) * 100).toFixed(1)}% correct  ` +
            `log loss ${(totalLoss / Math.max(totalGames, 1)).toFixed(4)}`
    );

    const upcoming = currentWeeks.filter(week => week.week >= weekOf(today));
    console.log(`\n${currentSeason}: ${upcoming.length} week(s) from ${weekOf(today)} onward.`);
    const next = upcoming[0];
    if (next) {
        console.log(`Week beginning ${next.week}, ${next.games.length} fixtures. Closest calls:`);
        for (const game of [...next.games].sort((a, b) => a.confidence - b.confidence).slice(0, 5)) {
            console.log(
                `  ${game.date}  ${game.home} vs ${game.away}  ` +
                    `${(game.p_home * 100).toFixed(0)}/${(game.p_draw * 100).toFixed(0)}/${(game.p_away * 100).toFixed(0)}`
            );
        }
    }
    console.log(`\nWrote ${PREDICTIONS_DIR}`);
}

main();
