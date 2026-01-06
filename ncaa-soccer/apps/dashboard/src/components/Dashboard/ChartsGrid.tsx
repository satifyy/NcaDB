import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    Title,
    Tooltip,
    Legend,
    PointElement,
    LineElement
} from 'chart.js';
import { Bar, Scatter } from 'react-chartjs-2';
import type { PlayerStat } from '../../types';

ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend
);

interface ChartsGridProps {
    data: PlayerStat[];
}

export function ChartsGrid({ data }: ChartsGridProps) {
    const accentColor = '#6366f1';
    const successColor = '#10b981';
    const gridColor = '#334155';
    const textColor = '#94a3b8';

    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#1e293b',
                titleColor: '#f8fafc',
                bodyColor: '#94a3b8',
                borderColor: '#334155',
                borderWidth: 1,
                padding: 10,
                displayColors: false,
            }
        },
        scales: {
            x: {
                grid: { display: false, color: gridColor },
                ticks: { color: textColor }
            },
            y: {
                grid: { color: gridColor },
                ticks: { color: textColor }
            }
        }
    };

    // 1. Top Scorers
    const topScorers = [...data].sort((a, b) => b.goals - a.goals).slice(0, 10);
    const goalsData = {
        labels: topScorers.map(p => p.player_name),
        datasets: [{
            label: 'Goals',
            data: topScorers.map(p => p.goals),
            backgroundColor: accentColor,
            borderRadius: 4,
        }]
    };

    // 2. Efficiency (Scatter)
    const efficiencyPoints = data
        .filter(p => p.shots >= 5)
        .map(p => ({
            x: p.shots,
            y: p.goals,
            name: p.player_name,
            rate: (p.goals / p.shots * 100).toFixed(1)
        }));

    const efficiencyData = {
        datasets: [{
            label: 'Player',
            data: efficiencyPoints,
            backgroundColor: (ctx: any) => {
                const rate = ctx.raw?.y / ctx.raw?.x;
                return rate > 0.2 ? successColor : accentColor;
            },
            pointRadius: 6,
            pointHoverRadius: 8
        }]
    };

    const efficiencyOptions = {
        ...commonOptions,
        plugins: {
            ...commonOptions.plugins,
            tooltip: {
                ...commonOptions.plugins.tooltip,
                callbacks: {
                    label: (ctx: any) => `${ctx.raw.name}: ${ctx.raw.y}G / ${ctx.raw.x}S (${ctx.raw.rate}%)`
                }
            }
        },
        scales: {
            x: { ...commonOptions.scales.x, title: { display: true, text: 'Total Shots', color: textColor } },
            y: { ...commonOptions.scales.y, title: { display: true, text: 'Goals', color: textColor } }
        }
    };

    // 3. Contribution (Stacked Bar)
    const topContributors = [...data]
        .sort((a, b) => (b.goals + b.assists) - (a.goals + a.assists))
        .slice(0, 10);

    const contributionData = {
        labels: topContributors.map(p => p.player_name),
        datasets: [
            {
                label: 'Goals',
                data: topContributors.map(p => p.goals),
                backgroundColor: accentColor,
                stack: 'Stack 0',
                borderRadius: 4,
            },
            {
                label: 'Assists',
                data: topContributors.map(p => p.assists),
                backgroundColor: successColor,
                stack: 'Stack 0',
                borderRadius: 4,
            }
        ]
    };

    return (
        <section style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
            gap: '1.5rem',
            marginBottom: '2rem'
        }}>
            <ChartCard title="Top Goal Scorers">
                <Bar data={goalsData} options={commonOptions} />
            </ChartCard>
            <ChartCard title="Efficiency: Goals vs Shots (Min 5 Shots)">
                <Scatter data={efficiencyData} options={efficiencyOptions} />
            </ChartCard>
            <ChartCard title="Goal Contributions (G + A)">
                <Bar data={contributionData} options={commonOptions} />
            </ChartCard>
        </section>
    );
}

function ChartCard({ title, children }: { title: string, children: React.ReactNode }) {
    return (
        <div style={{
            backgroundColor: 'var(--color-bg-secondary)',
            padding: '1.5rem',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--color-bg-tertiary)',
            height: '350px',
            display: 'flex',
            flexDirection: 'column'
        }}>
            <h3 className="font-medium" style={{ marginBottom: '1rem', color: 'var(--color-text-primary)' }}>{title}</h3>
            <div style={{ flex: 1, position: 'relative' }}>
                {children}
            </div>
        </div>
    );
}
