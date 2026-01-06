import type { PlayerStat } from '../../types';
import { Users, Goal, TrendingUp, Activity } from 'lucide-react';

interface KPIGridProps {
    stats: PlayerStat[];
}

export function KPIGrid({ stats }: KPIGridProps) {
    const totalPlayers = stats.length;
    const totalGoals = stats.reduce((sum, p) => sum + p.goals, 0);

    // Top Scorer
    const topScorer = [...stats].sort((a, b) => b.goals - a.goals)[0];

    // Most Efficient (Min 3 goals)
    const efficientPlayer = [...stats]
        .filter(p => p.goals >= 3)
        .map(p => ({
            ...p,
            rate: p.shots > 0 ? (p.goals / p.shots) * 100 : 0
        }))
        .sort((a, b) => b.rate - a.rate)[0];

    // Avg Goals/Game (Global) - Approximation if we don't have total games per team easily, 
    // but we can avg player g/90.
    // Let's us show Avg Goals per Player for now as a simple metric.
    const avgGoals = totalPlayers > 0 ? (totalGoals / totalPlayers).toFixed(1) : '0.0';

    return (
        <section style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '1.5rem',
            marginBottom: '2rem'
        }}>
            <KPICard
                title="Total Players"
                value={totalPlayers.toLocaleString()}
                icon={<Users size={20} />}
                trend="Active Roster"
            />
            <KPICard
                title="Total Goals"
                value={totalGoals.toLocaleString()}
                icon={<Goal size={20} />}
                trend={`${avgGoals} per player`}
            />
            <KPICard
                title="Top Scorer"
                value={topScorer ? topScorer.player_name : '-'}
                subValue={topScorer ? `${topScorer.goals} Goals` : ''}
                icon={<TrendingUp size={20} />}
                highlight
            />
            <KPICard
                title="Most Efficient"
                value={efficientPlayer ? efficientPlayer.player_name : '-'}
                subValue={efficientPlayer ? `${efficientPlayer.rate.toFixed(1)}% Conv. Rate` : ''}
                icon={<Activity size={20} />}
                highlight
            />
        </section>
    );
}

function KPICard({ title, value, subValue, icon, trend, highlight }: any) {
    return (
        <div style={{
            backgroundColor: 'var(--color-bg-secondary)',
            padding: '1.5rem',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--color-bg-tertiary)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between'
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                <span className="text-muted text-sm font-medium">{title}</span>
                <div style={{
                    color: highlight ? 'var(--color-accent-primary)' : 'var(--color-text-muted)',
                    backgroundColor: highlight ? 'var(--color-accent-light)' : 'rgba(255,255,255,0.05)',
                    padding: '0.5rem',
                    borderRadius: 'var(--radius-md)'
                }}>
                    {icon}
                </div>
            </div>
            <div>
                <div style={{
                    fontSize: highlight && value.length > 15 ? '1.25rem' : '1.75rem',
                    fontWeight: 700,
                    color: highlight ? 'var(--color-accent-primary)' : 'var(--color-text-primary)',
                    marginBottom: subValue ? '0.25rem' : '0'
                }}>
                    {value}
                </div>
                {subValue && (
                    <div className="text-muted text-sm">{subValue}</div>
                )}
                {trend && (
                    <div className="text-muted text-sm" style={{ marginTop: '0.25rem' }}>{trend}</div>
                )}
            </div>
        </div>
    );
}
