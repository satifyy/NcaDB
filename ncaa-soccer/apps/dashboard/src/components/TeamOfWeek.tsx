/**
 * Team of the Week: the eleven best-rated players of a Monday–Sunday week, in a 4-3-3.
 *
 * Everything shown is precomputed by the worker (`/api/v1/team-of-week`). The pitch is
 * one way to read the XI; the table beside it (always on a phone, a toggle elsewhere) is
 * the same information as text, so nothing depends on seeing the formation.
 */

import { useMemo, useRef, useState } from 'react';
import { useApi } from '../api';
import { count, percent, shortDate } from '../format';
import { href } from '../route';
import { Notice, SectionEyebrow } from './ui';

type Group = 'GK' | 'DEF' | 'MID' | 'FWD';

interface GameLog {
    game_id: number;
    date: string;
    opponent: string;
    team_score: number;
    opponent_score: number;
    minutes: number;
    goals: number | null;
    assists: number | null;
    shots_on_goal: number | null;
    saves: number | null;
    goals_allowed: number | null;
    goals_allowed_source: 'official' | 'inferred' | null;
    score: number;
    components: Record<string, number>;
}

export interface TotwPlayer {
    id: number;
    name: string;
    team: { id: number; slug: string; name: string };
    position_group: Group;
    position: string | null;
    rating: number;
    score: number;
    best_game: number;
    rank: number;
    games: number;
    minutes: number;
    missing: string[];
    explanation: string;
    game_log: GameLog[];
}

interface Slot {
    slot: number;
    position_group: Group;
    player: TotwPlayer | null;
}

export interface TotwWeek {
    week: {
        start: string;
        end: string;
        season: number;
        competition: { code: string; name: string };
        status: 'in_progress' | 'provisional' | 'final';
        revision: number;
        computed_at: string;
        completeness: {
            final_games: number;
            games_with_boxscore: number;
            games_captured: number;
            position_share: number | null;
            keeper_official_ga_share: number | null;
            keeper_saves_share: number | null;
            /** False when the week had too few captured games for an XI. */
            published?: boolean;
            reason?: string | null;
        };
        previous: string | null;
        next: string | null;
    };
    formation: string;
    xi: Slot[];
    filled: number;
    best: Record<Group, TotwPlayer | null>;
    honorable_mentions: Record<Group, TotwPlayer[]>;
    model: { version: string; summary: string };
}

interface WeekListing {
    start: string;
    end: string;
    status: string;
    filled: number;
}

const GROUP_NAME: Record<Group, string> = { GK: 'Goalkeeper', DEF: 'Defender', MID: 'Midfielder', FWD: 'Forward' };
const GROUP_PLURAL: Record<Group, string> = { GK: 'Goalkeepers', DEF: 'Defenders', MID: 'Midfielders', FWD: 'Forwards' };
const GROUPS: Group[] = ['GK', 'DEF', 'MID', 'FWD'];

const STATUS: Record<TotwWeek['week']['status'], { label: string; note: string; badge: string }> = {
    in_progress: { label: 'In progress', note: 'This week is still being played; selections change as games finish.', badge: 'is-upset' },
    provisional: { label: 'Provisional', note: 'Box scores can still be corrected for a week after the last game.', badge: 'is-draw' },
    final: { label: 'Final', note: 'The correction window has closed.', badge: 'is-final' }
};

const COMPONENT_LABEL: Record<string, string> = {
    goals: 'Goals',
    assists: 'Assists',
    shots_on_target: 'Shots on target (not scored)',
    result: 'Result',
    clean_sheet: 'Clean sheet',
    goals_conceded: 'Goals conceded while on the field',
    goals_allowed: 'Goals allowed',
    saves: 'Saves'
};

const MISSING_LABEL: Record<string, string> = {
    saves: 'saves were not reported in at least one game',
    goals_allowed_official: 'goals allowed taken from the final score (no goalkeeping table)',
    shots_on_goal: 'shots on goal were not reported in at least one game'
};

/** "Oct 6 – 12", "Sep 29 – Oct 5". */
function weekRange(start: string, end: string): string {
    const a = new Date(`${start}T00:00:00Z`);
    const b = new Date(`${end}T00:00:00Z`);
    const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    const sameMonth = a.getUTCMonth() === b.getUTCMonth();
    return `${month(a)} ${a.getUTCDate()} – ${sameMonth ? '' : `${month(b)} `}${b.getUTCDate()}`;
}

/** "Fay Forward" → "Forward"; names are stored "First Last". */
const surname = (name: string) => {
    const parts = name.trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(' ') : name;
};

/** The numbers that matter for a position, as short "2 G · 1 A" text. */
function keyStats(player: TotwPlayer): string {
    const sum = (key: keyof GameLog) => player.game_log.reduce((s, g) => s + (Number(g[key]) || 0), 0);
    const parts: string[] = [];
    if (player.position_group === 'GK') {
        const withSaves = player.game_log.filter(g => g.saves !== null);
        if (withSaves.length) parts.push(`${sum('saves')} SV`);
        parts.push(`${sum('goals_allowed')} GA`);
    } else {
        const g = sum('goals');
        const a = sum('assists');
        if (g) parts.push(`${g} G`);
        if (a) parts.push(`${a} A`);
        if (!g && !a) {
            const cs = player.game_log.filter(x => x.components.clean_sheet).length;
            if (cs) parts.push(`${cs} CS`);
        }
    }
    parts.push(`${player.games} GP`);
    return parts.join(' · ');
}

function describe(slot: Slot): string {
    const p = slot.player;
    if (!p) return `${GROUP_NAME[slot.position_group]}: no eligible player this week`;
    return `${GROUP_NAME[slot.position_group]}: ${p.name}, ${p.team.name}, rating ${p.rating.toFixed(1)}, ${keyStats(p)}`;
}

/** One marker on the pitch: a button that selects the player for the detail panel. */
function PitchMarker({ slot, selected, onSelect }: { slot: Slot; selected: boolean; onSelect: (p: TotwPlayer) => void }) {
    const p = slot.player;
    if (!p) {
        return (
            <div className="totw-marker is-empty" role="listitem" aria-label={describe(slot)}>
                <span className="totw-marker-pos">{slot.position_group}</span>
                <span className="totw-marker-name">No eligible player</span>
            </div>
        );
    }
    return (
        <div role="listitem" className="totw-marker-cell">
            <button
                type="button"
                className={selected ? 'totw-marker is-selected' : 'totw-marker'}
                aria-pressed={selected}
                aria-label={describe(slot)}
                onClick={() => onSelect(p)}
            >
                <span className="totw-marker-rating">{p.rating.toFixed(1)}</span>
                <span className="totw-marker-name">
                    <span className="totw-name-full">{p.name}</span>
                    <span className="totw-name-short">{surname(p.name)}</span>
                </span>
                <span className="totw-marker-team">{p.team.name}</span>
                <span className="totw-marker-stats">{keyStats(p)}</span>
            </button>
        </div>
    );
}

function Pitch({ xi, selected, onSelect }: { xi: Slot[]; selected: number | null; onSelect: (p: TotwPlayer) => void }) {
    // Attack at the top, keeper at the bottom: the way a formation is drawn.
    const lines: Group[] = ['FWD', 'MID', 'DEF', 'GK'];
    return (
        <div className="totw-pitch" role="group" aria-label="Team of the Week on a pitch, 4-3-3, forwards first">
            <svg className="totw-pitch-lines" viewBox="0 0 100 140" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                <rect x="2" y="2" width="96" height="136" />
                <line x1="2" y1="70" x2="98" y2="70" />
                <circle cx="50" cy="70" r="11" />
                <rect x="24" y="2" width="52" height="20" />
                <rect x="38" y="2" width="24" height="7" />
                <rect x="24" y="118" width="52" height="20" />
                <rect x="38" y="131" width="24" height="7" />
            </svg>
            {lines.map(group => (
                <div className={`totw-line is-${group.toLowerCase()}`} role="list" aria-label={GROUP_PLURAL[group]} key={group}>
                    {xi.filter(s => s.position_group === group).map(slot => (
                        <PitchMarker key={slot.slot} slot={slot} selected={slot.player?.id === selected} onSelect={onSelect} />
                    ))}
                </div>
            ))}
        </div>
    );
}

/** The XI as a table: the text alternative to the pitch, and the phone's main list. */
function XiTable({ xi, selected, onSelect }: { xi: Slot[]; selected: number | null; onSelect: (p: TotwPlayer) => void }) {
    return (
        <div className="table-scroll">
            <table className="broadsheet-table totw-table">
                <caption className="visually-hidden">Team of the Week, goalkeeper first</caption>
                <thead>
                    <tr>
                        <th scope="col">Pos</th>
                        <th scope="col">Player</th>
                        <th scope="col" className="numeric">Rating</th>
                        <th scope="col" className="totw-col-stats">Week</th>
                    </tr>
                </thead>
                <tbody>
                    {xi.map(slot => (
                        <tr key={slot.slot} className={slot.player && slot.player.id === selected ? 'is-selected' : undefined}>
                            <td><span className="badge">{slot.position_group}</span></td>
                            {slot.player ? (
                                <>
                                    <td>
                                        <button type="button" className="totw-row-button" onClick={() => onSelect(slot.player!)}
                                            aria-pressed={slot.player.id === selected}>
                                            <span className="font-medium">{slot.player.name}</span>
                                            <span className="text-muted text-sm">{slot.player.team.name}</span>
                                        </button>
                                    </td>
                                    <td className="numeric"><strong>{slot.player.rating.toFixed(1)}</strong></td>
                                    <td className="text-sm totw-col-stats">{keyStats(slot.player)}</td>
                                </>
                            ) : (
                                <td colSpan={3} className="text-muted text-sm">No eligible player this week</td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function PlayerDetail({ player, panelRef }: { player: TotwPlayer; panelRef: React.RefObject<HTMLDivElement | null> }) {
    return (
        <div className="totw-detail" ref={panelRef} tabIndex={-1} aria-live="polite">
            <div className="totw-detail-head">
                <span className="badge">{GROUP_NAME[player.position_group]}{player.position ? ` · listed “${player.position}”` : ''}</span>
                <span className="totw-detail-rating" aria-label={`Rating ${player.rating.toFixed(1)} out of 10`}>
                    {player.rating.toFixed(1)}<span className="text-muted">/10</span>
                </span>
            </div>
            <h3 className="headline-secondary totw-detail-name">
                <a className="data-link" href={href('directory', player.id)}>{player.name}</a>
            </h3>
            <div className="text-muted text-sm">
                <a className="data-link" href={href('teams', player.team.slug)}>{player.team.name}</a>
                {' · '}#{player.rank} {GROUP_PLURAL[player.position_group].toLowerCase()} this week
            </div>
            <p className="totw-detail-why">{player.explanation}</p>
            {player.missing.length > 0 && (
                <p className="text-sm totw-detail-missing">
                    Not counted against them: {player.missing.map(m => MISSING_LABEL[m] ?? m).join('; ')}.
                </p>
            )}
            <div className="totw-games">
                {player.game_log.map(g => (
                    <div className="totw-game" key={g.game_id}>
                        <div className="totw-game-head">
                            <a className="data-link font-medium" href={href('games', g.game_id)}>
                                vs {g.opponent}
                            </a>
                            <span className="text-muted text-sm">
                                {shortDate(g.date)} · {g.team_score}–{g.opponent_score} · {g.minutes}′
                            </span>
                        </div>
                        <dl className="totw-components">
                            {Object.entries(g.components).map(([key, value]) => (
                                <div key={key}>
                                    <dt>
                                        {COMPONENT_LABEL[key] ?? key}
                                        {key === 'goals_allowed' && g.goals_allowed_source === 'inferred' ? ' (from the score)' : ''}
                                    </dt>
                                    <dd className={value < 0 ? 'trend-down' : undefined}>{value > 0 ? '+' : ''}{value.toFixed(2)}</dd>
                                </div>
                            ))}
                            <div className="totw-components-total">
                                <dt>Game score</dt>
                                <dd>{g.score.toFixed(2)}</dd>
                            </div>
                        </dl>
                    </div>
                ))}
            </div>
            <a className="link-button" href={href('directory', player.id)}>Full player profile →</a>
        </div>
    );
}

function Rankings({ data, onSelect }: { data: TotwWeek; onSelect: (p: TotwPlayer) => void }) {
    return (
        <div className="totw-rankings">
            {GROUPS.map(group => {
                const best = data.best[group];
                const mentions = data.honorable_mentions[group];
                return (
                    <div className="totw-ranking" key={group}>
                        <div className="totw-ranking-title">Best {GROUP_NAME[group].toLowerCase()}</div>
                        {best ? (
                            <button type="button" className="totw-row-button" onClick={() => onSelect(best)}>
                                <span className="font-medium">{best.name} <strong className="totw-inline-rating">{best.rating.toFixed(1)}</strong></span>
                                <span className="text-muted text-sm">{best.team.name} · {keyStats(best)}</span>
                            </button>
                        ) : (
                            <span className="text-muted text-sm">No eligible player</span>
                        )}
                        {mentions.length > 0 && (
                            <>
                                <div className="totw-ranking-sub">Honorable mentions</div>
                                <ol className="totw-mentions">
                                    {mentions.map(p => (
                                        <li key={p.id}>
                                            <button type="button" className="totw-row-button" onClick={() => onSelect(p)}>
                                                <span>{p.name} <span className="text-muted">({p.team.name})</span></span>
                                                <span className="text-muted text-sm">{p.rating.toFixed(1)} · {keyStats(p)}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ol>
                            </>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function Freshness({ data }: { data: TotwWeek }) {
    const c = data.week.completeness;
    const status = STATUS[data.week.status];
    const computed = new Date(data.week.computed_at);
    return (
        <div className="totw-meta text-sm">
            <span className={`badge ${status.badge}`}>{status.label}</span>
            <span className="text-muted">
                {status.note}
                {data.week.revision > 0 && ` Revised ${data.week.revision} time${data.week.revision === 1 ? '' : 's'} after corrections.`}
            </span>
            <span className="text-muted">
                Box scores for {count(c.games_with_boxscore)} of {count(c.final_games)} games
                {c.position_share !== null && ` · positions on ${percent(c.position_share)} of player rows`}
                {' · '}updated {computed.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {' · '}model {data.model.version}
            </span>
        </div>
    );
}

export function TeamOfWeek() {
    const [week, setWeek] = useState<string | null>(null);
    const [competition, setCompetition] = useState('ncaa-d1-msoc');
    const [mode, setMode] = useState<'pitch' | 'table'>('pitch');
    // A choice made in one week does not follow the reader into another.
    const [choice, setChoice] = useState<{ week: string; id: number } | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const current = useApi<TotwWeek>(week ? `/api/v1/team-of-week/${week}` : '/api/v1/team-of-week', { competition });
    // The week on screen stays until the next one arrives, so moving between weeks does
    // not blank the section for the length of a request.
    const [shown, setShown] = useState<TotwWeek | null>(null);
    if (current.data && current.data !== shown) setShown(current.data);
    const data = current.data ?? (current.loading ? shown : null);
    const weeks = useApi<{ data: WeekListing[] }>(data ? '/api/v1/team-of-week/weeks' : null, { season: data?.week.season, competition });

    // Every player the section can show, so a selection survives switching views.
    const everyone = useMemo(() => {
        if (!data) return new Map<number, TotwPlayer>();
        const all = [
            ...data.xi.map(s => s.player),
            ...GROUPS.flatMap(g => data.honorable_mentions[g])
        ].filter((p): p is TotwPlayer => !!p);
        return new Map(all.map(p => [p.id, p]));
    }, [data]);

    // A week opens on its highest-rated player: the headline of the side.
    const opening = useMemo(() => {
        const best = data?.xi.filter(s => s.player).sort((a, b) => b.player!.rating - a.player!.rating || a.slot - b.slot)[0];
        return best?.player?.id ?? null;
    }, [data]);
    const selectedId = data && choice?.week === data.week.start ? choice.id : opening;

    const select = (p: TotwPlayer) => {
        if (data) setChoice({ week: data.week.start, id: p.id });
        // On a phone the panel sits below the list; take the reader to it.
        if (window.matchMedia('(max-width: 900px)').matches) {
            requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
            requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        }
    };

    const selected = selectedId !== null ? everyone.get(selectedId) ?? null : null;

    return (
        <section className="totw" aria-labelledby="totw-title" aria-busy={current.loading}>
            <SectionEyebrow>Team of the Week</SectionEyebrow>
            <div className="totw-head">
                <div>
                    <h2 className="headline-lead totw-title" id="totw-title">
                        {data ? `The XI · ${weekRange(data.week.start, data.week.end)}` : 'Team of the Week'}
                    </h2>
                    <p className="text-muted text-sm">
                        Eleven players chosen from box-score statistics alone, ranked against their own position. 4-3-3.
                    </p>
                </div>
                <div className="totw-controls">
                    <div className="totw-weeknav" role="group" aria-label="Week">
                        <button type="button" className="button" disabled={!data?.week.previous}
                            onClick={() => data?.week.previous && setWeek(data.week.previous)} aria-label="Previous week">
                            ← <span className="totw-hide-sm">Previous</span>
                        </button>
                        <label className="control totw-week-select">
                            <span className="visually-hidden">Choose a week</span>
                            <select value={data?.week.start ?? ''} onChange={e => setWeek(e.target.value)} disabled={!weeks.data}>
                                {!weeks.data && data && <option value={data.week.start}>{weekRange(data.week.start, data.week.end)}</option>}
                                {weeks.data?.data.map(w => (
                                    <option key={w.start} value={w.start}>
                                        {weekRange(w.start, w.end)}{w.status === 'final' ? '' : ` (${STATUS[w.status as keyof typeof STATUS]?.label.toLowerCase() ?? w.status})`}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <button type="button" className="button" disabled={!data?.week.next}
                            onClick={() => data?.week.next && setWeek(data.week.next)} aria-label="Next week">
                            <span className="totw-hide-sm">Next</span> →
                        </button>
                    </div>
                    <label className="control">
                        <span className="visually-hidden">Competition</span>
                        <select value={competition} onChange={e => { setCompetition(e.target.value); setWeek(null); }}>
                            <option value="ncaa-d1-msoc">NCAA D-I Men’s</option>
                        </select>
                    </label>
                </div>
            </div>

            {current.error && (
                <Notice kind="info">
                    {current.error.includes('not found')
                        ? 'No Team of the Week has been computed for this selection yet. It appears once captured box scores with positions are available.'
                        : current.error}
                </Notice>
            )}
            {current.loading && !data && <div className="empty-state">Loading the Team of the Week…</div>}

            {data && (
                <>
                    <Freshness data={data} />
                    {data.week.completeness.published === false ? (
                        <Notice kind="info">
                            Too few games had box scores with positions this week (
                            {count(data.week.completeness.games_captured)} of {count(data.week.completeness.final_games)})
                            to pick a meaningful XI. A week needs at least 20.
                        </Notice>
                    ) : data.filled < 11 && (
                        <Notice>
                            Only {data.filled} of 11 places could be filled: some positions had no player with enough
                            minutes and recorded positions this week. Empty places are left empty rather than filled
                            from another position.
                        </Notice>
                    )}
                    <div className="segmented totw-mode" role="group" aria-label="Show the team as">
                        <button type="button" aria-pressed={mode === 'pitch'} onClick={() => setMode('pitch')}>Pitch</button>
                        <button type="button" aria-pressed={mode === 'table'} onClick={() => setMode('table')}>Table</button>
                    </div>
                    <div className="totw-body">
                        <div className={`totw-main is-${mode}`}>
                            {mode === 'pitch' && <Pitch xi={data.xi} selected={selectedId} onSelect={select} />}
                            {/* The text version: the table mode, and below the pitch on a phone. */}
                            <div className={mode === 'pitch' ? 'totw-list-companion' : undefined}>
                                <XiTable xi={data.xi} selected={selectedId} onSelect={select} />
                            </div>
                        </div>
                        <div className="totw-aside">
                            {selected ? (
                                <PlayerDetail player={selected} panelRef={panelRef} />
                            ) : (
                                <div className="text-muted text-sm">Choose a player to see why they were selected.</div>
                            )}
                        </div>
                    </div>
                    <Rankings data={data} onSelect={select} />
                    <details className="totw-method">
                        <summary>How players are rated</summary>
                        <p>{data.model.summary}</p>
                    </details>
                </>
            )}
        </section>
    );
}
