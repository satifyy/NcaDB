import type { ReactNode } from 'react';
import type { PlayerStat } from '../../types';
import { Users, Goal, TrendingUp, Activity } from 'lucide-react';

/**
 * Shots a player needs before their conversion rate means anything.
 *
 * Three goals alone lets a player who took three shots and scored all three top the card
 * at 100%, which says more about the sample than about the finishing.
 */
const MIN_SHOTS = 20;

interface KPIGridProps {
    stats: PlayerStat[];
}

export function KPIGrid({ stats }: KPIGridProps) {
    const totalPlayers = stats.length;
    const totalGoals = stats.reduce((sum, p) => sum + p.goals, 0);

    const topScorer = [...stats].sort((a, b) => b.goals - a.goals)[0];

    const efficientPlayer = [...stats]
        .filter(p => p.goals >= 3 && p.shots >= MIN_SHOTS)
        .map(p => ({
            ...p,
            rate: p.shots > 0 ? (p.goals / p.shots) * 100 : 0
        }))
        .sort((a, b) => b.rate - a.rate)[0];

    const avgGoals = totalPlayers > 0 ? (totalGoals / totalPlayers).toFixed(1) : '0.0';

    return (
        <section className="grid grid-4" style={{ marginBottom: 'var(--space-6)' }}>
            <KPICard
                title="Players"
                value={totalPlayers.toLocaleString()}
                icon={<Users size={18} />}
                foot="With a box-score appearance"
            />
            <KPICard
                title="Goals"
                value={totalGoals.toLocaleString()}
                icon={<Goal size={18} />}
                foot={`${avgGoals} per player`}
            />
            <KPICard
                title="Top scorer"
                value={topScorer ? topScorer.player_name : '—'}
                icon={<TrendingUp size={18} />}
                foot={topScorer ? `${topScorer.team_id} · ${topScorer.goals} goals` : undefined}
                small
            />
            <KPICard
                title="Most efficient"
                value={efficientPlayer ? efficientPlayer.player_name : '—'}
                icon={<Activity size={18} />}
                foot={
                    efficientPlayer
                        ? `${efficientPlayer.rate.toFixed(1)}% of ${efficientPlayer.shots} shots scored`
                        : `Nobody has ${MIN_SHOTS} shots yet`
                }
                small
            />
        </section>
    );
}

interface KPICardProps {
    title: string;
    value: string;
    icon: ReactNode;
    foot?: string;
    /** For a name rather than a number, which needs the room more than the size. */
    small?: boolean;
}

function KPICard({ title, value, icon, foot, small }: KPICardProps) {
    return (
        <div className="stat">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                <span className="stat-label">{title}</span>
                <span style={{ color: 'var(--color-text-muted)', display: 'flex' }}>{icon}</span>
            </div>
            <div className={small ? 'stat-value is-small' : 'stat-value'}>{value}</div>
            {foot && <div className="stat-foot">{foot}</div>}
        </div>
    );
}
