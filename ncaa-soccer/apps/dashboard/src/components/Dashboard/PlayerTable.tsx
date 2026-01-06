import { useState } from 'react';
import type { PlayerStat } from '../../types';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

interface PlayerTableProps {
    data: PlayerStat[];
}

type SortField = keyof PlayerStat | 'conversion_rate' | 'g_per_90' | 'a_per_90';
type SortDirection = 'asc' | 'desc';

export function PlayerTable({ data }: PlayerTableProps) {
    const [page, setPage] = useState(1);
    const [sortField, setSortField] = useState<SortField>('goals');
    const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

    const rowsPerPage = 15;

    // Derived Metrics & Sorting
    const processedData = data.map(p => {
        const mins = p.minutes || 1;
        return {
            ...p,
            g_per_90: (p.goals / mins) * 90,
            a_per_90: (p.assists / mins) * 90,
            conversion_rate: p.shots > 0 ? (p.goals / p.shots) * 100 : 0
        };
    });

    const sortedData = [...processedData].sort((a, b) => {
        const valA = a[sortField];
        const valB = b[sortField];

        if (typeof valA === 'string' && typeof valB === 'string') {
            return sortDirection === 'asc'
                ? valA.localeCompare(valB)
                : valB.localeCompare(valA);
        }

        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });

    const totalPages = Math.ceil(sortedData.length / rowsPerPage);
    const startIndex = (page - 1) * rowsPerPage;
    const paginatedData = sortedData.slice(startIndex, startIndex + rowsPerPage);

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDirection('desc');
        }
    };

    const SortIcon = ({ field }: { field: SortField }) => {
        if (sortField !== field) return <div style={{ width: 16 }} />;
        return sortDirection === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />;
    };

    const Th = ({ field, label, numeric }: { field: SortField, label: string, numeric?: boolean }) => (
        <th
            onClick={() => handleSort(field)}
            style={{
                textAlign: numeric ? 'right' : 'left',
                cursor: 'pointer',
                userSelect: 'none',
                padding: '1rem',
                color: 'var(--color-text-muted)',
                fontWeight: 600,
                fontSize: '0.875rem',
                borderBottom: '1px solid var(--color-bg-tertiary)'
            }}
            className="hover:text-primary transition-colors"
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', justifyContent: numeric ? 'flex-end' : 'flex-start' }}>
                {label}
                <SortIcon field={field} />
            </div>
        </th>
    );

    return (
        <section style={{
            backgroundColor: 'var(--color-bg-secondary)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--color-bg-tertiary)',
            overflow: 'hidden'
        }}>
            <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--color-bg-tertiary)' }}>
                <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>Detailed Player Statistics</h2>
            </div>

            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '800px' }}>
                    <thead>
                        <tr>
                            <th style={{ padding: '1rem', textAlign: 'left', color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-bg-tertiary)' }}>#</th>
                            <Th field="player_name" label="Player" />
                            <Th field="team_id" label="Team" />
                            <Th field="games_played" label="GP" numeric />
                            <Th field="minutes" label="Min" numeric />
                            <Th field="goals" label="G" numeric />
                            <Th field="assists" label="A" numeric />
                            <Th field="g_per_90" label="G/90" numeric />
                            <Th field="conversion_rate" label="Conv %" numeric />
                            <Th field="shots" label="Sh" numeric />
                        </tr>
                    </thead>
                    <tbody>
                        {paginatedData.map((p, i) => (
                            <tr key={p.player_key} style={{ borderBottom: '1px solid var(--color-bg-tertiary)' }} className="hover:bg-slate-800/50">
                                <td style={{ padding: '1rem', color: 'var(--color-text-muted)' }}>{startIndex + i + 1}</td>
                                <td style={{ padding: '1rem' }}>
                                    <div className="font-medium" style={{ color: 'var(--color-text-primary)' }}>{p.player_name}</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                                        {p.jersey_number ? `#${p.jersey_number}` : ''}
                                    </div>
                                </td>
                                <td style={{ padding: '1rem' }}>
                                    <span style={{
                                        padding: '0.25rem 0.5rem',
                                        borderRadius: 'var(--radius-full)',
                                        backgroundColor: 'var(--color-bg-tertiary)',
                                        fontSize: '0.75rem'
                                    }}>
                                        {p.team_id}
                                    </span>
                                </td>
                                <td align="right" style={{ padding: '1rem' }}>{p.games_played}</td>
                                <td align="right" style={{ padding: '1rem' }}>{p.minutes}</td>
                                <td align="right" style={{ padding: '1rem', fontWeight: 700, color: 'var(--color-text-primary)' }}>{p.goals}</td>
                                <td align="right" style={{ padding: '1rem' }}>{p.assists}</td>
                                <td align="right" style={{ padding: '1rem' }}>{p.g_per_90.toFixed(2)}</td>
                                <td align="right" style={{ padding: '1rem', color: p.conversion_rate > 20 ? 'var(--color-success)' : 'inherit' }}>
                                    {p.conversion_rate.toFixed(1)}%
                                </td>
                                <td align="right" style={{ padding: '1rem' }}>{p.shots}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div style={{
                padding: '1rem 1.5rem',
                borderTop: '1px solid var(--color-bg-tertiary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
            }}>
                <span className="text-sm text-muted">Page {page} of {totalPages}</span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1}
                        style={{
                            padding: '0.5rem',
                            borderRadius: 'var(--radius-md)',
                            backgroundColor: 'var(--color-bg-tertiary)',
                            color: page === 1 ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
                            border: 'none',
                            opacity: page === 1 ? 0.5 : 1
                        }}
                    >
                        <ChevronLeft size={20} />
                    </button>
                    <button
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                        disabled={page === totalPages}
                        style={{
                            padding: '0.5rem',
                            borderRadius: 'var(--radius-md)',
                            backgroundColor: 'var(--color-bg-tertiary)',
                            color: page === totalPages ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
                            border: 'none',
                            opacity: page === totalPages ? 0.5 : 1
                        }}
                    >
                        <ChevronRight size={20} />
                    </button>
                </div>
            </div>
        </section>
    )
}
