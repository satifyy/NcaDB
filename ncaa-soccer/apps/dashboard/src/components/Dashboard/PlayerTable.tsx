import { useState } from 'react';
import type { PlayerStat } from '../../types';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

interface PlayerTableProps {
    data: PlayerStat[];
}

type SortField = keyof PlayerStat | 'conversion_rate' | 'g_per_90' | 'a_per_90';
type SortDirection = 'asc' | 'desc';

/**
 * The header cells, in the order they are drawn.
 *
 * A list rather than eleven hand-written `<Th>` elements, because every one of them took
 * the same four props and the sort state had to be threaded through each.
 */
const COLUMNS: { field: SortField; label: string; numeric?: boolean }[] = [
    { field: 'player_name', label: 'Player' },
    { field: 'team_id', label: 'Team' },
    { field: 'conference', label: 'Conference' },
    { field: 'games_played', label: 'GP', numeric: true },
    { field: 'minutes', label: 'Min', numeric: true },
    { field: 'goals', label: 'G', numeric: true },
    { field: 'assists', label: 'A', numeric: true },
    { field: 'g_per_90', label: 'G/90', numeric: true },
    { field: 'conversion_rate', label: 'Conv %', numeric: true },
    { field: 'shots', label: 'Sh', numeric: true }
];

/**
 * Declared here rather than inside {@link PlayerTable}.
 *
 * A component created during a render is a new component type on every render, so React
 * unmounts the old one and mounts a new one instead of updating it — the whole header
 * is torn down and rebuilt on every keystroke in the search box, and any state it held
 * would be lost each time.
 */
function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
    if (!active) return <div style={{ width: 16 }} />;
    return direction === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />;
}

function Th({
    field,
    label,
    numeric,
    sortField,
    sortDirection,
    onSort
}: {
    field: SortField;
    label: string;
    numeric?: boolean;
    sortField: SortField;
    sortDirection: SortDirection;
    onSort: (field: SortField) => void;
}) {
    return (
        <th
            onClick={() => onSort(field)}
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
                <SortIcon active={sortField === field} direction={sortDirection} />
            </div>
        </th>
    );
}

export function PlayerTable({ data }: PlayerTableProps) {
    // Narrowing the filters shortens the list, and page 40 of a 20-row result is blank,
    // so a new `data` array starts again at page 1. Stored alongside the page rather than
    // reset from an effect: an effect only runs after the blank page has already been
    // rendered and committed, so the reader sees the empty table flash by first.
    const [pagination, setPagination] = useState({ data, page: 1 });
    const page = pagination.data === data ? pagination.page : 1;
    const setPage = (next: number) => setPagination({ data, page: next });

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

        // The movement fields are null for players with too little history to compare;
        // those sort to the bottom rather than counting as zero, which would rank them
        // above anyone who genuinely declined.
        if (valA === null || valA === undefined) return 1;
        if (valB === null || valB === undefined) return -1;

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
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '940px' }}>
                    <thead>
                        <tr>
                            <th style={{ padding: '1rem', textAlign: 'left', color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-bg-tertiary)' }}>#</th>
                            {COLUMNS.map(column => (
                                <Th
                                    key={column.field}
                                    {...column}
                                    sortField={sortField}
                                    sortDirection={sortDirection}
                                    onSort={handleSort}
                                />
                            ))}
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
                                    {/* A career shows the schools in order, so a transfer
                                        reads as a move rather than as the last school only. */}
                                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                        {(p.teams ?? [p.team_id]).map((team, n) => (
                                            <span key={team} style={{
                                                padding: '0.25rem 0.5rem',
                                                borderRadius: 'var(--radius-full)',
                                                backgroundColor: 'var(--color-bg-tertiary)',
                                                fontSize: '0.75rem',
                                                opacity: n < (p.teams?.length ?? 1) - 1 ? 0.65 : 1
                                            }}>
                                                {team}
                                            </span>
                                        ))}
                                    </span>
                                    {p.season.includes('–') && (
                                        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>
                                            {p.season}
                                        </div>
                                    )}
                                </td>
                                <td style={{ padding: '1rem', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                                    {(p.conferences ?? [p.conference]).join(' · ')}
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
                        onClick={() => setPage(Math.max(1, page - 1))}
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
                        onClick={() => setPage(Math.min(totalPages, page + 1))}
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
