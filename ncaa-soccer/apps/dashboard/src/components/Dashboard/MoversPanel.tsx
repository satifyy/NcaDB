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
        <section
            style={{
                backgroundColor: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-bg-tertiary)',
                borderRadius: 'var(--radius-lg)',
                marginBottom: '2rem',
                overflow: 'hidden'
            }}
        >
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '1rem',
                    padding: '1.5rem',
                    borderBottom: '1px solid var(--color-bg-tertiary)'
                }}
            >
                <div style={{ marginRight: 'auto' }}>
                    <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>
                        Biggest Movers
                    </h2>
                    <p className="text-muted text-sm" style={{ marginTop: '0.25rem' }}>
                        {explanation}
                    </p>
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
                <p className="text-muted text-sm" style={{ padding: '1.5rem' }}>
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
                            <div style={{ minWidth: 0 }}>
                                <div className="font-medium" style={{ color: 'var(--color-text-primary)' }}>
                                    {m.player.player_name}
                                </div>
                                <div className="text-muted text-sm">
                                    {m.player.team_id} • {m.player.conference}
                                </div>
                            </div>
                            <span className="movers-change text-muted text-sm">
                                {m.previous} → <strong style={{ color: 'var(--color-text-primary)' }}>{m.current}</strong>
                            </span>
                            <span className={`movers-delta ${m.delta > 0 ? 'is-up' : 'is-down'}`}>
                                {m.delta > 0 ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}
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
