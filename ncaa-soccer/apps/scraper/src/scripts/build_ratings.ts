/**
 * Fits the rating models and writes everything downstream of them.
 *
 * This is the stage that turns a pile of results and box scores into the two numbers the
 * site is built on: what a team is worth (Elo) and what a player is worth (impact). It
 * does four things in order, and the order matters.
 *
 * 1. **Judge each season.** A season missing more than a fifth of Division I is excluded
 *    before anything is fitted on it. 2020 is the reason — most of the country moved that
 *    season to spring 2021 or did not play it, and averaging it in silently would corrupt
 *    every rating that crosses it. The verdict is written to `data/season_coverage.json`
 *    so the dashboard can say which years it is and is not making claims about.
 *
 * 2. **Fit Elo, then the forecast.** The Elo parameters are searched by running the whole
 *    history under each candidate and scoring the *pre-game* ratings against what actually
 *    happened — a walk-forward test, never a fit to games the ratings already absorbed.
 *    Everything is fitted on all but the last two seasons and reported on those two, so
 *    the accuracy printed at the end is out-of-sample.
 *
 * 3. **Value every player-game.** Impact is opponent-adjusted, and the opponent's strength
 *    is its Elo at kickoff, so this can only run once the ratings exist.
 *
 * 4. **Feed the roster back in.** Elo cannot see that a team graduated its whole front
 *    line. Returning production can, so a final pass tries a roster term on the
 *    season-to-season carryover and keeps it only if it improves the held-out log loss.
 *    If it does not, it is reported as not helping and set to zero rather than shipped.
 *
 * **The parameters are not refitted on every run.** A daily refresh adds last night's
 * results; it does not learn anything new about how college soccer works. Refitting anyway
 * would move every parameter a little, which moves every rating in every season a little,
 * which rewrites eleven seasons of ratings, impact scores and forecasts — tens of
 * megabytes of churn committed daily for no new information. With the parameters held
 * fixed, Elo is sequential: yesterday's games cannot change 2017's ratings, so every
 * completed season's files come out byte-identical and the diff is only what actually
 * changed. Refitting is therefore something you ask for.
 *
 * Usage:
 *   npx tsx apps/scraper/src/scripts/build_ratings.ts            # reuse the fitted model
 *   npx tsx apps/scraper/src/scripts/build_ratings.ts --refit    # search the parameters again
 *   npx tsx apps/scraper/src/scripts/build_ratings.ts --quick    # defaults, no search, no reuse
 */

import * as fs from 'fs';
import * as path from 'path';
import { COVERAGE_PATH, impactCsv, IMPACT_DIR, RATINGS_DIR, writeRows } from '@ncaa/storage';
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
import { loadMatches, conflictingFixtures, Match } from '../analytics/matches';
import { EloParams, DEFAULT_ELO, rateHistory, RatedGame, BASELINE } from '../analytics/elo';
import {
    Observation,
    OutcomeParams,
    GoalsParams,
    fitOutcome,
    fitGoals,
    scorecard,
    calibration,
    observationOf
} from '../analytics/outcome';
import { minimise } from '../analytics/optimize';
import { assessSeason, SeasonCoverage } from '../analytics/coverage';
import { loadPlayerGames, rosterSizes } from '../analytics/dataset';
import {
    GameContext,
    GameImpact,
    SeasonImpact,
    leagueRates,
    valueGame,
    summariseSeason,
    returningProduction,
    qualifyingMinutes
} from '../analytics/impact';


/** Seasons held out of every fit, so the reported accuracy is against unseen games. */
const HOLDOUT_SEASONS = 2;

function log(message: string): void {
    console.log(message);
}

/** Games as the fitters see them, given a set of Elo parameters. */
function observationsFor(rated: RatedGame[]): Observation[] {
    const out: Observation[] = [];
    for (const game of rated) {
        const ratingDiff = game.home_elo_before - game.away_elo_before;
        const observation = observationOf(game, game.elo_diff, ratingDiff);
        if (observation) out.push(observation);
    }
    return out;
}

interface Fit {
    elo: EloParams;
    outcome: OutcomeParams;
    goals: GoalsParams;
    train: ReturnType<typeof scorecard>;
    test: ReturnType<typeof scorecard>;
}

/**
 * Searches the Elo parameters against held-out seasons.
 *
 * The loss is the log loss of the outcome model fitted on the training games, evaluated
 * on the same training games — the held-out seasons are kept out of the search entirely
 * so that the number reported at the end has not been optimised against. Elo's own
 * ratings are already walk-forward within the training set, which is what stops the
 * search from simply memorising results.
 */
/**
 * The parameters a previous run fitted, if there are any.
 *
 * Read rather than refitted by default; see the note at the top of the file.
 */
function storedParameters(): { elo: EloParams; weight: number } | null {
    try {
        const model = JSON.parse(fs.readFileSync(path.join(RATINGS_DIR, 'model.json'), 'utf8'));
        if (!model?.elo?.k) return null;
        return { elo: model.elo as EloParams, weight: Number(model.returning_production_weight) || 0 };
    } catch {
        return null;
    }
}

function fitParameters(matches: Match[], rated: Set<string>, search: boolean, testFrom: string, start?: EloParams): Fit {
    const isTest = (m: Match) => m.season >= testFrom;

    // The outcome model is refitted inside every candidate rather than carried between
    // them. A draw band fitted against one set of ratings and then applied to another is
    // not the model that was scored, and the mismatch is invisible — it shows up only as
    // slightly miscalibrated probabilities on the finished site.
    const evaluate = (elo: EloParams): number => {
        const { rated_games } = rateHistory(matches, elo, rated);
        const observations = observationsFor(rated_games.filter(g => !isTest(g)));
        return scorecard(observations, fitOutcome(observations)).log_loss;
    };

    let eloParams = { ...(start ?? DEFAULT_ELO) };
    if (search) {
        // Bounded through a squashing function rather than by rejecting proposals: an
        // unbounded simplex will happily try a negative K or a carryover above one, and a
        // rejected proposal makes the search stall instead of turn.
        const bound = (x: number, low: number, high: number) => low + (high - low) / (1 + Math.exp(-x));
        // Clamped away from the bounds before inverting: a weight the last fit drove to 0
        // would come back as -Infinity here and poison the whole simplex, so a refit that
        // starts from `model.json` would fail on exactly the parameter it had settled.
        const unbound = (v: number, low: number, high: number) => {
            const span = high - low;
            const clamped = Math.min(high - span * 1e-4, Math.max(low + span * 1e-4, v));
            return Math.log((clamped - low) / (high - clamped));
        };
        const unpack = (v: number[]): EloParams => ({
            ...DEFAULT_ELO,
            k: bound(v[0], 5, 100),
            homeAdvantage: bound(v[1], 0, 150),
            carryover: bound(v[2], 0.3, 1),
            marginDamping: bound(v[3], 0.5, 6),
            initialUnrated: bound(v[4], 1000, 1500)
        });

        const from = [
            unbound(eloParams.k, 5, 100),
            unbound(eloParams.homeAdvantage, 0, 150),
            unbound(eloParams.carryover, 0.3, 1),
            unbound(eloParams.marginDamping, 0.5, 6),
            unbound(eloParams.initialUnrated, 1000, 1500)
        ];

        log('Fitting Elo parameters (walk-forward over the training seasons)...');
        const found = minimise(v => evaluate(unpack(v)), from, [0.6, 0.6, 0.6, 0.6, 0.6], 120);
        eloParams = unpack(found.params);
        log(`  ${found.iterations} iterations, training log loss ${found.loss.toFixed(5)}`);
    }

    const { rated_games } = rateHistory(matches, eloParams, rated);
    const trainObservations = observationsFor(rated_games.filter(g => !isTest(g)));
    const testObservations = observationsFor(rated_games.filter(isTest));
    const outcome = fitOutcome(trainObservations);
    const goals = fitGoals(trainObservations);

    return {
        elo: eloParams,
        outcome,
        goals,
        train: scorecard(trainObservations, outcome),
        test: scorecard(testObservations, outcome)
    };
}

/** Values every player-game in a season against the ratings the games were played at. */
async function seasonImpact(
    season: string,
    resolveTeam: (raw: string) => string,
    matchesById: Map<string, RatedGame | Match>,
    eloById: Map<string, { home: number; away: number }>,
    conferenceOf: (team: string) => string,
    isDivisionOne: (team: string) => boolean
): Promise<{ players: SeasonImpact[]; games: GameImpact[] }> {
    const rows = await loadPlayerGames(season, resolveTeam);
    if (rows.length === 0) return { players: [], games: [] };

    // Which team-games recorded saves at all, and how many. Half of them do not, and both
    // the league save rate and each keeper's rating have to be measured over the half that
    // did — see `SaveSample`.
    const savesByTeamGame = new Map<string, number>();
    for (const row of rows) {
        const key = `${row.game_id}|${row.team}`;
        savesByTeamGame.set(key, (savesByTeamGame.get(key) ?? 0) + row.saves);
    }

    const sample = { saves: 0, conceded: 0 };
    for (const [key, saves] of savesByTeamGame) {
        if (saves === 0) continue;
        const [gameId, team] = [key.slice(0, key.lastIndexOf('|')), key.slice(key.lastIndexOf('|') + 1)];
        const match = matchesById.get(gameId);
        if (!match || !match.played) continue;
        const isHome = match.home === team;
        if (!isHome && match.away !== team) continue;
        sample.saves += saves;
        sample.conceded += isHome ? match.away_score! : match.home_score!;
    }
    const rates = leagueRates(rows, sample);

    // A keeper is a keeper for the season, not for the game: judging per game would let a
    // keeper who conceded three without making a save escape being counted at all.
    const keepers = new Set<string>();
    for (const row of rows) if (row.saves > 0) keepers.add(row.identity);

    const games: GameImpact[] = [];
    for (const row of rows) {
        const match = matchesById.get(row.game_id);
        if (!match) continue;
        const isHome = match.home === row.team;
        // A box score whose team resolves to neither side of its fixture cannot be placed
        // — crediting it to the home team by default would invent an opponent.
        if (!isHome && match.away !== row.team) continue;

        const elo = eloById.get(row.game_id);
        const context: GameContext = {
            game_id: match.game_id,
            season: match.season,
            date: match.date,
            week: match.week,
            opponentOf: () => (isHome ? match.away : match.home),
            opponentElo: () => (elo ? (isHome ? elo.away : elo.home) : BASELINE),
            concededBy: () => (match.played ? (isHome ? match.away_score! : match.home_score!) : null),
            scoredBy: () => (match.played ? (isHome ? match.home_score! : match.away_score!) : null),
            savesRecorded: team => (savesByTeamGame.get(`${row.game_id}|${team}`) ?? 0) > 0
        };
        games.push(valueGame(row, context, rates, keepers.has(row.identity)));
    }

    return { players: summariseSeason(games, conferenceOf, isDivisionOne), games };
}

interface WeeklyStandout {
    season: string;
    week: string;
    identity: string;
    player_name: string;
    team: string;
    conference: string;
    opponent: string | null;
    date: string;
    minutes: number;
    goals: number;
    assists: number;
    shots_on_goal: number;
    saves: number;
    goals_against: number;
    is_keeper: boolean;
    impact: number;
    result: 'W' | 'D' | 'L' | null;
    score: string | null;
}

/** How many players a week's standout list holds. */
const STANDOUTS_PER_WEEK = 10;

/**
 * The best individual performances of each week.
 *
 * Ranked on a single game rather than on form, because that is what "player of the week"
 * means, and on opponent-adjusted impact rather than on goals, so a keeper's ten-save
 * shutout can win it and a hat-trick against an exhibition opponent does not
 * automatically.
 */
function standoutsByWeek(games: GameImpact[], conferenceOf: (team: string) => string): WeeklyStandout[] {
    const byWeek = new Map<string, GameImpact[]>();
    for (const game of games) {
        if (game.minutes < 20) continue;
        const list = byWeek.get(game.week) || [];
        list.push(game);
        byWeek.set(game.week, list);
    }

    const out: WeeklyStandout[] = [];
    for (const [week, played] of byWeek) {
        played.sort((a, b) => b.impact - a.impact);
        for (const game of played.slice(0, STANDOUTS_PER_WEEK)) {
            out.push({
                season: game.season,
                week,
                identity: game.identity,
                player_name: game.player_name,
                team: game.team,
                conference: conferenceOf(game.team),
                opponent: game.opponent,
                date: game.date,
                minutes: game.minutes,
                goals: game.goals,
                assists: game.assists,
                shots_on_goal: game.shots_on_goal,
                saves: game.saves,
                goals_against: Math.round(game.goals_against * 10) / 10,
                is_keeper: game.saves > 0 || game.goals_against > 0,
                impact: Math.round(game.impact * 1000) / 1000,
                result: game.result,
                score: game.scored === null ? null : `${game.scored}-${game.conceded}`
            });
        }
    }
    return out.sort((a, b) => a.week.localeCompare(b.week) || b.impact - a.impact);
}

interface TeamRating {
    team: string;
    conference: string;
    elo: number;
    rank: number;
    conference_rank: number;
    played: number;
    wins: number;
    draws: number;
    losses: number;
    goals_for: number;
    goals_against: number;
    peak_elo: number;
    peak_season: string;
    /** Elo at the end of each season the team played. */
    by_season: Record<string, number>;
    /** Change over the last four weeks of the current season. */
    trend: number;
    rated: boolean;
}

async function main(): Promise<void> {
    const quick = process.argv.includes('--quick');
    const stored = quick ? null : storedParameters();
    const refit = process.argv.includes('--refit') || (!quick && stored === null);

    const teams = buildTeamIndex();
    const statSeasons = seasonsOnDisk();
    const canonical = canonicalTeamNames(statSeasons, teams);
    const resolveTeam = makeTeamResolver(canonical, teams);
    const conferenceOf = (team: string) => teams.find(team)?.conference || UNAFFILIATED;

    const ratedTeams = new Set(loadTeams(INVENTORY).map(team => team.name_canonical));
    log(`Inventory: ${ratedTeams.size} Division I programs`);

    const allSeasons = gameSeasonsOnDisk();
    const allMatches = loadMatches(allSeasons, resolveTeam, ratedTeams);
    log(`Loaded ${allMatches.length} fixtures across ${allSeasons.length} seasons`);

    // Fixtures where two Division I schools are both claimed as the same opponent cannot
    // be repaired from here — there is no unknown side to name after the known one — so
    // they are counted rather than passed over in silence.
    const conflicts = conflictingFixtures(allMatches, ratedTeams);
    if (conflicts.length > 0) {
        log(
            `${conflicts.length} fixture(s) name two different Division I schools as the same ` +
                'opponent, from a short form resolved wrongly at scrape time. Both are rated; ' +
                're-scraping those seasons clears them.'
        );
        for (const conflict of conflicts.slice(0, 3)) {
            log(`   ${conflict.date}  ${conflict.shared} vs ${conflict.a} / ${conflict.b}`);
        }
    }
    log('');

    // --- 1. which seasons are complete enough to count ----------------------------
    log('=== season coverage ===');
    const coverage: SeasonCoverage[] = [];
    for (const season of allSeasons) {
        const rows = statSeasons.includes(season) ? await loadPlayerGames(season, resolveTeam) : [];
        const players = new Set(rows.map(row => row.identity)).size;
        const assessment = assessSeason(
            {
                season,
                rosterSizes: rosterSizes(rows),
                matches: allMatches.filter(match => match.season === season),
                players
            },
            ratedTeams
        );
        coverage.push(assessment);
        log(
            `  ${season}  rosters ${assessment.teams_with_roster}/${assessment.rated_teams} ` +
                `(${(assessment.roster_share * 100).toFixed(0)}%)  ` +
                `${assessment.played_games} played  ${assessment.players} players  ` +
                `${assessment.usable ? 'USABLE' : 'EXCLUDED — ' + assessment.note}`
        );
    }
    fs.mkdirSync(path.dirname(COVERAGE_PATH), { recursive: true });
    fs.writeFileSync(
        COVERAGE_PATH,
        `${JSON.stringify({ generated_at: new Date().toISOString(), seasons: coverage }, null, 4)}\n`
    );

    const usable = coverage.filter(c => c.usable).map(c => c.season);
    const excluded = coverage.filter(c => !c.usable).map(c => c.season);
    if (usable.length === 0) {
        console.error('\nNo season has enough roster coverage to rate. Nothing written.');
        process.exit(1);
    }
    log(`\nRating ${usable.length} season(s): ${usable.join(', ')}` +
        (excluded.length > 0 ? `; excluded ${excluded.join(', ')}` : ''));

    const matches = allMatches.filter(match => usable.includes(match.season));

    // --- 2. fit ------------------------------------------------------------------
    const testFrom = usable[Math.max(0, usable.length - HOLDOUT_SEASONS)];
    log(`\n=== model (holdout: ${usable.slice(-HOLDOUT_SEASONS).join(', ')}) ===`);
    log(
        refit
            ? '  Refitting from scratch.'
            : quick
              ? '  Using the built-in defaults (--quick).'
              : '  Reusing the parameters in model.json. Pass --refit to search again.'
    );
    const fit = fitParameters(matches, ratedTeams, refit, testFrom, stored?.elo);
    log(
        `  Elo: K=${fit.elo.k.toFixed(1)} home=${fit.elo.homeAdvantage.toFixed(1)} ` +
            `carryover=${fit.elo.carryover.toFixed(3)} margin=${fit.elo.marginDamping.toFixed(2)} ` +
            `unrated start=${fit.elo.initialUnrated.toFixed(0)}`
    );
    log(
        `  Draw band: overtime era ${fit.outcome.drawBand.overtime.toFixed(3)}, ` +
            `no-overtime era ${fit.outcome.drawBand['no-overtime'].toFixed(3)}; ` +
            `slope ${fit.outcome.beta.toFixed(5)}/pt`
    );
    log(
        `  Train  ${fit.train.games} games  log loss ${fit.train.log_loss.toFixed(4)} ` +
            `(base ${fit.train.baseline_log_loss.toFixed(4)})  accuracy ${(fit.train.accuracy * 100).toFixed(1)}%`
    );
    log(
        `  Test   ${fit.test.games} games  log loss ${fit.test.log_loss.toFixed(4)} ` +
            `(base ${fit.test.baseline_log_loss.toFixed(4)})  accuracy ${(fit.test.accuracy * 100).toFixed(1)}%`
    );

    // --- 3. rate, then value every player-game ------------------------------------
    const firstPass = rateHistory(matches, fit.elo, ratedTeams);
    const eloById = new Map<string, { home: number; away: number }>();
    for (const game of firstPass.rated_games) {
        eloById.set(game.game_id, { home: game.home_elo_before, away: game.away_elo_before });
    }
    const matchesById = new Map<string, Match>(matches.map(match => [match.game_id, match]));

    log('\n=== player impact ===');
    fs.mkdirSync(IMPACT_DIR, { recursive: true });
    const impactBySeason = new Map<string, SeasonImpact[]>();
    const standouts: WeeklyStandout[] = [];

    for (const season of usable) {
        if (!statSeasons.includes(season)) {
            log(`  ${season}  no box scores on disk, skipped`);
            continue;
        }
        const { players, games } = await seasonImpact(
            season,
            resolveTeam,
            matchesById,
            eloById,
            conferenceOf,
            team => ratedTeams.has(team)
        );
        if (players.length === 0) continue;
        impactBySeason.set(season, players);
        standouts.push(...standoutsByWeek(games, conferenceOf));

        writeRows(
            impactCsv(season),
            players.map(player => ({
                ...player,
                // Written as words: csv-stringify renders `true` as 1 and `false` as an
                // empty cell, and an empty cell is indistinguishable from missing data.
                is_keeper: String(player.is_keeper),
                qualified: String(player.qualified),
                division_one: String(player.division_one),
                impact: player.impact.toFixed(3),
                impact_per90: player.impact_per90.toFixed(4),
                goals_against: player.goals_against.toFixed(1),
                opponent_strength: Math.round(player.opponent_strength)
            }))
        );
        const qualified = players.filter(p => p.qualified && p.division_one).length;
        const best = players.find(p => p.qualified && p.division_one);
        const bar = qualifyingMinutes(players.map(p => p.minutes));
        log(
            `  ${season}  ${players.length} players (${qualified} D1 over ${bar} minutes)` +
                (best ? `  leader ${best.player_name} (${best.team}) ${best.impact.toFixed(1)}` : '')
        );
    }

    // --- 4. does the roster tell us anything Elo did not? -------------------------
    log('\n=== returning production ===');
    const returning = returningProduction(impactBySeason);
    const isTest = (m: Match) => m.season >= testFrom;
    const scoreWith = (weight: number) => {
        const params = { ...fit.elo, returningWeight: weight };
        const { rated_games } = rateHistory(matches, params, ratedTeams, returning);
        const train = observationsFor(rated_games.filter(g => !isTest(g)));
        const test = observationsFor(rated_games.filter(isTest));
        const outcome = fitOutcome(train);
        return { weight, params, outcome, train: scorecard(train, outcome), test: scorecard(test, outcome) };
    };

    const without = scoreWith(0);
    let best = stored && !refit ? scoreWith(stored.weight) : without;
    if (refit && returning.size > 0) {
        for (const weight of [25, 50, 75, 100, 150, 200, 250, 300, 400]) {
            const candidate = scoreWith(weight);
            if (candidate.train.log_loss < best.train.log_loss) best = candidate;
        }
    }
    log(`  ${returning.size} team-seasons have a previous year to compare against.`);
    log(
        `  weight 0    train ${without.train.log_loss.toFixed(5)}  test ${without.test.log_loss.toFixed(5)}`
    );
    if (best.weight === 0) {
        log('  No weight improved the training fit; the roster term is switched off.');
    } else {
        log(
            `  weight ${String(best.weight).padEnd(4)} train ${best.train.log_loss.toFixed(5)}  ` +
                `test ${best.test.log_loss.toFixed(5)}   <- ${refit ? 'chosen on training loss' : 'from model.json'}`
        );
        // Chosen on the training seasons, so whether it also helps on the held-out ones is
        // the only evidence that it is a real effect rather than a fitted one.
        const helped = best.test.log_loss < without.test.log_loss;
        log(
            helped
                ? '  It improves the held-out seasons too, so it is a real effect.'
                : '  It does NOT improve the held-out seasons — treat it as fitted noise.'
        );
    }

    // --- 5. final ratings ---------------------------------------------------------
    const final = rateHistory(matches, best.params, ratedTeams, returning);
    const finalGoals = fitGoals(observationsFor(final.rated_games.filter(g => !isTest(g))));
    const testObservations = observationsFor(final.rated_games.filter(isTest));

    const currentSeason = usable[usable.length - 1];
    const records = new Map<
        string,
        { played: number; wins: number; draws: number; losses: number; for: number; against: number }
    >();
    const peaks = new Map<string, { elo: number; season: string }>();
    const bySeasonEnd = new Map<string, Map<string, number>>();
    const weekly = new Map<string, Map<string, number>>();

    for (const game of final.rated_games) {
        for (const side of ['home', 'away'] as const) {
            const team = side === 'home' ? game.home : game.away;
            const scored = side === 'home' ? game.home_score! : game.away_score!;
            const conceded = side === 'home' ? game.away_score! : game.home_score!;
            const after = side === 'home' ? game.home_elo_after : game.away_elo_after;

            if (game.season === currentSeason) {
                const record = records.get(team) || {
                    played: 0,
                    wins: 0,
                    draws: 0,
                    losses: 0,
                    for: 0,
                    against: 0
                };
                record.played++;
                if (scored > conceded) record.wins++;
                else if (scored < conceded) record.losses++;
                else record.draws++;
                record.for += scored;
                record.against += conceded;
                records.set(team, record);
            }

            const peak = peaks.get(team);
            if (!peak || after > peak.elo) peaks.set(team, { elo: after, season: game.season });

            const seasonEnd = bySeasonEnd.get(team) || new Map<string, number>();
            seasonEnd.set(game.season, after);
            bySeasonEnd.set(team, seasonEnd);

            const timeline = weekly.get(team) || new Map<string, number>();
            timeline.set(game.week, after);
            weekly.set(team, timeline);
        }
    }

    const ratings: TeamRating[] = final
        .engine.table()
        .map(({ team, elo }) => {
            const record = records.get(team);
            const timeline = [...(weekly.get(team) || new Map())]
                .filter(([week]) => week >= `${currentSeason}-01-01`)
                .sort((a, b) => a[0].localeCompare(b[0]));
            const fourWeeksAgo = timeline[Math.max(0, timeline.length - 5)];
            return {
                team,
                conference: conferenceOf(team),
                elo: Math.round(elo),
                rank: 0,
                conference_rank: 0,
                played: record?.played ?? 0,
                wins: record?.wins ?? 0,
                draws: record?.draws ?? 0,
                losses: record?.losses ?? 0,
                goals_for: record?.for ?? 0,
                goals_against: record?.against ?? 0,
                peak_elo: Math.round(peaks.get(team)?.elo ?? elo),
                peak_season: peaks.get(team)?.season ?? currentSeason,
                by_season: Object.fromEntries(
                    [...(bySeasonEnd.get(team) || new Map())].map(([season, value]) => [
                        season,
                        Math.round(value)
                    ])
                ),
                trend: fourWeeksAgo ? Math.round(elo - fourWeeksAgo[1]) : 0,
                rated: ratedTeams.has(team)
            };
        })
        .sort((a, b) => b.elo - a.elo);

    // Ranks are over Division I only: a table where an exhibition opponent that beat
    // nobody sits eleventh is not a ranking anyone asked for.
    let rank = 0;
    const conferenceCounts = new Map<string, number>();
    for (const rating of ratings) {
        if (!rating.rated) continue;
        rating.rank = ++rank;
        const next = (conferenceCounts.get(rating.conference) || 0) + 1;
        conferenceCounts.set(rating.conference, next);
        rating.conference_rank = next;
    }

    fs.mkdirSync(RATINGS_DIR, { recursive: true });
    fs.writeFileSync(
        path.join(RATINGS_DIR, 'team_ratings.json'),
        `${JSON.stringify(
            {
                generated_at: new Date().toISOString(),
                current_season: currentSeason,
                seasons: usable,
                excluded_seasons: excluded,
                teams: ratings
            },
            null,
            0
        )}\n`
    );

    // The timeline is the chart's data and nothing else's, so it is its own file: it is
    // several times the size of the table and the table is what loads on arrival.
    const timeline = [...weekly]
        .filter(([team]) => ratedTeams.has(team))
        .map(([team, weeks]) => ({
            team,
            points: [...weeks]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([week, elo]) => [week, Math.round(elo)] as [string, number])
        }));
    fs.writeFileSync(
        path.join(RATINGS_DIR, 'elo_timeline.json'),
        `${JSON.stringify({ generated_at: new Date().toISOString(), teams: timeline })}\n`
    );

    writeRows(
        path.join(RATINGS_DIR, 'elo_history.csv'),
        final.rated_games.map(game => ({
            game_id: game.game_id,
            season: game.season,
            date: game.date,
            week: game.week,
            home: game.home,
            away: game.away,
            home_score: game.home_score,
            away_score: game.away_score,
            neutral: game.neutral,
            home_elo_before: game.home_elo_before.toFixed(1),
            away_elo_before: game.away_elo_before.toFixed(1),
            elo_diff: game.elo_diff.toFixed(1),
            elo_change: game.elo_change.toFixed(2)
        }))
    );

    fs.writeFileSync(
        path.join(RATINGS_DIR, 'standouts.json'),
        `${JSON.stringify({ generated_at: new Date().toISOString(), weeks: standouts })}\n`
    );

    const model = {
        generated_at: new Date().toISOString(),
        fitted_on: usable.filter(season => season < testFrom),
        held_out: usable.filter(season => season >= testFrom),
        elo: best.params,
        outcome: best.outcome,
        goals: finalGoals,
        returning_production_weight: best.weight,
        returning_production_effect: {
            weight: best.weight,
            with: { train: best.train.log_loss, test: best.test.log_loss },
            without: { train: without.train.log_loss, test: without.test.log_loss }
        },
        performance: {
            train: best.train,
            test: best.test,
            calibration: calibration(testObservations, best.outcome)
        }
    };
    fs.writeFileSync(path.join(RATINGS_DIR, 'model.json'), `${JSON.stringify(model, null, 4)}\n`);

    const top = ratings.filter(r => r.rated).slice(0, 10);
    log(`\n=== top of the table (${currentSeason}) ===`);
    for (const team of top) {
        log(
            `  ${String(team.rank).padStart(2)}. ${team.team.padEnd(24)} ${team.elo}  ` +
                `${team.wins}-${team.draws}-${team.losses}  ${team.conference}`
        );
    }

    log(`\nWrote ratings to ${RATINGS_DIR}`);
    log(`Coverage verdict -> ${COVERAGE_PATH}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
