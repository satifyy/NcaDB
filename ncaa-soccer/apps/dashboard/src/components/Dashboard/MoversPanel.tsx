import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { MoversMode, PlayerStat } from '../../types';

interface MoversPanelProps {
    data: PlayerStat[];
    mode: MoversMode;
    comparedTo: string | null;
}

const SHOWN = 8;

/**
 * Who gained and lost the most goal contributions.
 *
 * Ranked from whatever the filters leave rather than from a precomputed national top ten,
 * because a leaderboard that ignores the conference you just selected is answering a
 * question you did not ask.
 */
export function MoversPanel({ data, mode, comparedTo }: MoversPanelProps) {
    const [direction, setDirection] = useState<'up' | 'down'>('up');

    const ranked = useMemo(() => {
        const movers = data
            // Career rows omit the pair entirely rather than writing it null, so this has
            // to be a nullish test rather than a null one.
            .filter(p => p.movement_current != null && p.movement_previous != null)
            .map(p => ({
                player: p,
                current: p.movement_current as number,
                previous: p.movement_previous as number,
                delta: (p.movement_current as number) - (p.movement_previous as number)
            }))
            // Only movement in the direction being shown. Sorting alone would pad a short
            // list of risers with the least-bad fallers, under a heading saying otherwise.
            .filter(m => (direction === 'up' ? m.delta > 0 : m.delta < 0));

        movers.sort((a, b) => (direction === 'up' ? b.delta - a.delta : a.delta - b.delta));
        return movers.slice(0, SHOWN);
    }, [data, direction]);

    const explanation =
        mode === 'season'
            ? `Goal contributions against the same player's ${comparedTo} season`
            : mode === 'pace'
              ? `Goal contributions so far, against the same number of games of their ${comparedTo} season`
              : 'Goal contributions in the last 3 games against the 3 before them';

    return (
        <section className="card movers-panel">
            <div className="card-head movers-head">
                <div className="movers-title">
                    <h2 className="card-title">Biggest movers</h2>
                    <p className="card-note">{explanation}</p>
                </div>

                <div className="segmented" role="group" aria-label="Direction">
                    <button
                        type="button"
                        aria-pressed={direction === 'up'}
                        onClick={() => setDirection('up')}
                    >
                        Risers
                    </button>
                    <button
                        type="button"
                        aria-pressed={direction === 'down'}
                        onClick={() => setDirection('down')}
                    >
                        Fallers
                    </button>
                </div>
            </div>

            {ranked.length === 0 ? (
                <p className="card-body text-muted text-sm">
                    {`No ${direction === 'up' ? 'riser' : 'faller'}s in this selection. `}
                    {mode === 'form'
                        ? 'A player needs six games for this comparison.'
                        : 'A player has to have played both seasons to be compared.'}
                </p>
            ) : (
                <ol className="movers-list">
                    {ranked.map((m, i) => (
                        <li key={m.player.player_key} className="movers-row">
                            <span className="movers-rank">{i + 1}</span>
                            <div className="movers-who">
                                <div className="font-medium text-strong">{m.player.player_name}</div>
                                <div className="text-muted text-sm">
                                    {m.player.team_id} • {m.player.conference}
                                </div>
                            </div>
                            <span className="movers-change text-muted text-sm">
                                {m.previous} → <strong className="text-strong">{m.current}</strong>
                            </span>
                            <span className={`movers-delta ${m.delta > 0 ? 'is-up' : 'is-down'}`}>
                                {m.delta > 0 ? <ArrowUpRight size={16} aria-hidden="true" /> : <ArrowDownRight size={16} aria-hidden="true" />}
                                {m.delta > 0 ? '+' : ''}
                                {m.delta}
                            </span>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}
