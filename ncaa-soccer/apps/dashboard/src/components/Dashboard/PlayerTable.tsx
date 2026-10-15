import { useState } from 'react';
import type { PlayerStat } from '../../types';
import { Card } from '../ui';
import { Pager, SortHeader, TableScroll } from '../data';

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
const COLUMNS: { field: SortField; label: string; title?: string; numeric?: boolean; className?: string }[] = [
    { field: 'player_name', label: 'Player', className: 'col-sticky' },
    { field: 'team_id', label: 'Team' },
    { field: 'conference', label: 'Conference' },
    { field: 'games_played', label: 'GP', title: 'Games played', numeric: true },
    { field: 'minutes', label: 'Min', title: 'Minutes', numeric: true },
    { field: 'goals', label: 'G', title: 'Goals', numeric: true },
    { field: 'assists', label: 'A', title: 'Assists', numeric: true },
    { field: 'g_per_90', label: 'G/90', title: 'Goals per 90 minutes', numeric: true },
    { field: 'conversion_rate', label: 'Conv %', title: 'Shot conversion rate', numeric: true },
    { field: 'shots', label: 'Sh', title: 'Shots', numeric: true }
];

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
        <Card title="Detailed player statistics" note={`${sortedData.length.toLocaleString()} players`} bodyless>
            <TableScroll label="Detailed player statistics">
                <table className="data-table">
                    <thead>
                        <tr>
                            <th scope="col" className="rank-cell">#</th>
                            {COLUMNS.map(column => (
                                <SortHeader
                                    key={column.field}
                                    label={column.label}
                                    title={column.title}
                                    numeric={column.numeric}
                                    className={column.className}
                                    active={sortField === column.field}
                                    direction={sortDirection === 'asc' ? 'ascending' : 'descending'}
                                    onSort={() => handleSort(column.field)}
                                />
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {paginatedData.map((p, i) => (
                            <tr key={p.player_key}>
                                <td className="rank-cell">{startIndex + i + 1}</td>
                                <td className="team-cell col-sticky">
                                    {p.player_name}
                                    {p.jersey_number && <div className="cell-sub">#{p.jersey_number}</div>}
                                </td>
                                <td>
                                    {/* A career shows the schools in order, so a transfer
                                        reads as a move rather than as the last school only. */}
                                    <span className="team-trail">
                                        {(p.teams ?? [p.team_id]).map((team, n) => (
                                            <span key={team} className={n < (p.teams?.length ?? 1) - 1 ? 'badge is-past' : 'badge'}>
                                                {team}
                                            </span>
                                        ))}
                                    </span>
                                    {p.season.includes('–') && <div className="cell-sub">{p.season}</div>}
                                </td>
                                <td className="text-muted">{(p.conferences ?? [p.conference]).join(' · ')}</td>
                                <td className="numeric">{p.games_played}</td>
                                <td className="numeric">{p.minutes.toLocaleString()}</td>
                                <td className="numeric font-bold">{p.goals}</td>
                                <td className="numeric">{p.assists}</td>
                                <td className="numeric">{p.g_per_90.toFixed(2)}</td>
                                <td className={p.conversion_rate > 20 ? 'numeric delta is-up' : 'numeric'}>
                                    {p.conversion_rate.toFixed(1)}%
                                </td>
                                <td className="numeric">{p.shots}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </TableScroll>
            <Pager page={page} pages={totalPages} total={sortedData.length} onPage={setPage} />
        </Card>
    );
}
