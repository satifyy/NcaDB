import { useState, useMemo } from 'react';
import { Header } from './components/Layout/Header';
import { KPIGrid } from './components/Dashboard/KPIGrid';
import { ChartsGrid } from './components/Dashboard/ChartsGrid';
import { PlayerTable } from './components/Dashboard/PlayerTable';
import playerStatsData from './data/player_stats.json';
import type { PlayerStat } from './types';

function App() {
  const [searchTerm, setSearchTerm] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');

  // Cast imported JSON to typed array
  const allStats: PlayerStat[] = playerStatsData as unknown as PlayerStat[];

  // Extract unique teams
  const teams = useMemo(() => {
    return [...new Set(allStats.map(p => p.team_id))].sort();
  }, [allStats]);

  // Filter Data
  const filteredData = useMemo(() => {
    const lowerTerm = searchTerm.toLowerCase();
    return allStats.filter(p => {
      const matchesSearch =
        p.player_name.toLowerCase().includes(lowerTerm) ||
        p.team_id.toLowerCase().includes(lowerTerm);
      const matchesTeam = teamFilter === 'all' || p.team_id === teamFilter;

      return matchesSearch && matchesTeam;
    });
  }, [allStats, searchTerm, teamFilter]);

  return (
    <div className="container" style={{ paddingBottom: '4rem' }}>
      <Header onSearch={setSearchTerm} />

      <main>
        {/* Controls */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem' }}>
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--color-bg-secondary)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-bg-tertiary)',
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            <option value="all">All Teams</option>
            {teams.map(team => (
              <option key={team} value={team}>{team}</option>
            ))}
          </select>
        </div>

        <KPIGrid stats={filteredData} />

        <ChartsGrid data={filteredData} />

        <PlayerTable data={filteredData} />
      </main>
    </div>
  );
}

export default App;
