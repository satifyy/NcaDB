import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import type { PredictedGame } from '../analytics';
import { percent, shortDate } from '../format';

/** A number that needs no chart: one figure, its label, and one line of context. */
export function Stat({
    label,
    value,
    foot,
    small
}: {
    label: string;
    value: ReactNode;
    foot?: ReactNode;
    small?: boolean;
}) {
    return (
        <div className="stat">
            <div className="stat-label">{label}</div>
            <div className={small ? 'stat-value is-small' : 'stat-value'}>{value}</div>
            {foot && <div className="stat-foot">{foot}</div>}
        </div>
    );
}

export function Card({
    title,
    note,
    children,
    bodyless
}: {
    title: string;
    note?: ReactNode;
    children: ReactNode;
    /** Content that supplies its own padding, such as a full-bleed table or list. */
    bodyless?: boolean;
}) {
    return (
        <section className="card">
            <div className="card-head">
                <h2 className="card-title">{title}</h2>
                {note && <span className="card-note">{note}</span>}
            </div>
            {bodyless ? children : <div className="card-body">{children}</div>}
        </section>
    );
}

export function Notice({ children, kind = 'warning' }: { children: ReactNode; kind?: 'warning' | 'info' }) {
    return (
        <div className={kind === 'info' ? 'notice is-info' : 'notice'} role="note">
            {kind === 'info' ? <Info size={18} /> : <AlertTriangle size={18} />}
            <div>{children}</div>
        </div>
    );
}

/**
 * A legend, always present once a chart carries two series.
 *
 * Identity is never colour alone — the swatch is beside a name, and charts with four or
 * fewer series also label their marks directly.
 */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
    return (
        <div className="legend">
            {items.map(item => (
                <span className="legend-item" key={item.label}>
                    <span className="legend-swatch" style={{ backgroundColor: `var(${item.color})` }} />
                    {item.label}
                </span>
            ))}
        </div>
    );
}

const OUTCOME_LABEL = { home: 'Home win', draw: 'Draw', away: 'Away win' } as const;

/**
 * One fixture: who is playing, what the model thinks, and what happened.
 *
 * The three probabilities are a single bar rather than three numbers because the question
 * a reader has is "how close is this", and a shape answers that before any digit is read.
 * Home and away take the two poles of the diverging pair and the draw the neutral middle,
 * which is what those outcomes are; a 2px gap keeps the segments from merging into one
 * block.
 */
export function MatchCard({ game }: { game: PredictedGame }) {
    const [home, draw, away] = game.p;
    const settled = game.outcome !== null;

    return (
        <article className="match">
            <div className="match-head">
                <span>
                    {shortDate(game.date)}
                    {game.neutral && ' · neutral site'}
                </span>
                <span style={{ display: 'inline-flex', gap: '0.375rem' }}>
                    {game.upset && <span className="badge is-upset">Upset</span>}
                    {settled && (
                        <span className={`badge ${game.correct ? 'is-win' : 'is-loss'}`}>
                            {game.correct ? 'Called' : 'Missed'}
                        </span>
                    )}
                </span>
            </div>

            <div className="match-teams">
                <div className="match-team">
                    <div className="match-team-name" title={game.home}>
                        {game.home}
                    </div>
                    <div className="match-team-elo">{game.home_elo} Elo · {game.home_conference}</div>
                </div>
                <div className="match-score">
                    {settled ? `${game.home_score}–${game.away_score}` : <span className="match-vs">vs</span>}
                </div>
                <div className="match-team is-away">
                    <div className="match-team-name" title={game.away}>
                        {game.away}
                    </div>
                    <div className="match-team-elo">{game.away_elo} Elo · {game.away_conference}</div>
                </div>
            </div>

            <div
                className="prob-bar"
                role="img"
                aria-label={`Forecast: home win ${percent(home)}, draw ${percent(draw)}, away win ${percent(away)}`}
            >
                <span className="prob-seg is-home" style={{ width: `${home * 100}%` }} />
                <span className="prob-seg is-draw" style={{ width: `${draw * 100}%` }} />
                <span className="prob-seg is-away" style={{ width: `${away * 100}%` }} />
            </div>

            <div className="prob-labels">
                <span className={game.pick === 'home' ? undefined : 'text-muted'}>
                    {game.pick === 'home' ? <strong>{percent(home)}</strong> : percent(home)} home
                </span>
                <span className={game.pick === 'draw' ? undefined : 'text-muted'}>
                    {game.pick === 'draw' ? <strong>{percent(draw)}</strong> : percent(draw)} draw
                </span>
                <span className={game.pick === 'away' ? undefined : 'text-muted'}>
                    {game.pick === 'away' ? <strong>{percent(away)}</strong> : percent(away)} away
                </span>
            </div>

            <div className="match-foot">
                <span>
                    Expected {game.xg[0].toFixed(1)}–{game.xg[1].toFixed(1)}
                    {game.scorelines[0] && ` · likeliest ${game.scorelines[0].score}`}
                </span>
                <span>
                    Pick: {OUTCOME_LABEL[game.pick]}
                    {settled && ` · ${OUTCOME_LABEL[game.outcome!]}`}
                </span>
            </div>
        </article>
    );
}
