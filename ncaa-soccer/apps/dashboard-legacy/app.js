// Assuming window.playerStats is populated by data.js

const ROWS_PER_PAGE = 15;
let currentPage = 1;
let currentSort = { field: 'goals', direction: 'desc' };
let filteredData = [];
let chartInstances = {};

// Theme Colors
const COLORS = {
    accent: '#6366f1',
    accentLight: 'rgba(99, 102, 241, 0.5)',
    success: '#10b981',
    text: '#94a3b8',
    textLight: '#f1f5f9',
    grid: '#334155'
};

document.addEventListener('DOMContentLoaded', () => {
    if (!window.playerStats) {
        console.error("No data found! Run generate_dashboard_data.ts first.");
        return;
    }

    // Enrich Data with Derived Metrics
    window.playerStats = window.playerStats.map(p => {
        const mins = p.minutes || 1; // Avoid divide by zero
        return {
            ...p,
            g_per_90: (p.goals / mins) * 90,
            a_per_90: (p.assists / mins) * 90,
            // Min 5 shots to avoid 1/1 = 100% outlier skewedness for main metric sorting, though we calculate for all
            conversion_rate: p.shots > 0 ? (p.goals / p.shots) * 100 : 0
        };
    });

    filteredData = [...window.playerStats];

    initTeamFilter();
    updateStatsOverview();
    renderAllCharts();
    renderTable();

    // Listeners
    document.getElementById('search-input').addEventListener('input', handleSearch);
    document.getElementById('team-filter').addEventListener('change', handleFilter);
    document.getElementById('prev-page').addEventListener('click', () => changePage(-1));
    document.getElementById('next-page').addEventListener('click', () => changePage(1));

    document.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => handleSort(th.dataset.sort));
    });
});

function initTeamFilter() {
    const teams = [...new Set(window.playerStats.map(p => p.team_id))].sort();
    const select = document.getElementById('team-filter');
    teams.forEach(team => {
        const option = document.createElement('option');
        option.value = team;
        option.textContent = team;
        select.appendChild(option);
    });
}

function updateStatsOverview() {
    const totalPlayers = window.playerStats.length;
    const totalGoals = window.playerStats.reduce((sum, p) => sum + p.goals, 0);

    // Top Scorer
    const topScorer = [...window.playerStats].sort((a, b) => b.goals - a.goals)[0];

    // Most Efficient (Min 3 goals to qualify)
    const efficientPlayer = [...window.playerStats]
        .filter(p => p.goals >= 3)
        .sort((a, b) => b.conversion_rate - a.conversion_rate)[0];

    document.getElementById('total-players').textContent = totalPlayers.toLocaleString();
    document.getElementById('total-goals').textContent = totalGoals.toLocaleString();
    // Assuming roughly 25 games played by UNC as base, but we don't have total games count easily available for all teams combined logic without more data.
    // For now, let's just leave the subtext static or calculated based on something else if needed.

    if (topScorer) {
        document.getElementById('top-scorer-name').textContent = topScorer.player_name;
        document.getElementById('top-scorer-goals').textContent = `${topScorer.goals} Goals`;
    }

    if (efficientPlayer) {
        document.getElementById('most-efficient-name').textContent = efficientPlayer.player_name;
        document.getElementById('most-efficient-rate').textContent = `${efficientPlayer.conversion_rate.toFixed(1)}% Conv. Rate`;
    }
}

function renderAllCharts() {
    // Shared Chart Defaults
    Chart.defaults.color = COLORS.text;
    Chart.defaults.borderColor = COLORS.grid;
    Chart.defaults.font.family = "'Inter', sans-serif";

    renderGoalsChart();
    renderEfficiencyChart();
    renderPer90Chart();
    renderContributionChart();
}

function renderGoalsChart() {
    const ctx = document.getElementById('goalsChart').getContext('2d');
    const top10 = [...window.playerStats].sort((a, b) => b.goals - a.goals).slice(0, 10);

    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: top10.map(p => p.player_name),
            datasets: [{
                label: 'Goals',
                data: top10.map(p => p.goals),
                backgroundColor: COLORS.accent,
                borderRadius: 4,
                hoverBackgroundColor: COLORS.accentHover
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: '#334155' } },
                x: { grid: { display: false } }
            }
        }
    });
}

function renderEfficiencyChart() {
    const ctx = document.getElementById('efficiencyChart').getContext('2d');
    // Filter out low sample size for cleaner chart
    const dataPoints = window.playerStats
        .filter(p => p.shots >= 5)
        .map(p => ({
            x: p.shots,
            y: p.goals,
            name: p.player_name,
            rate: p.conversion_rate.toFixed(1)
        }));

    new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [{
                label: 'Efficiency',
                data: dataPoints,
                backgroundColor: (ctx) => {
                    const rate = ctx.raw?.y / ctx.raw?.x;
                    return rate > 0.2 ? COLORS.success : COLORS.accent;
                }
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.raw.name}: ${ctx.raw.y} goals / ${ctx.raw.x} shots (${ctx.raw.rate}%)`
                    }
                },
                legend: { display: false }
            },
            scales: {
                x: { title: { display: true, text: 'Total Shots' } },
                y: { title: { display: true, text: 'Goals' } }
            }
        }
    });
}

function renderPer90Chart() {
    const ctx = document.getElementById('per90Chart').getContext('2d');
    const qualified = window.playerStats
        .filter(p => p.minutes > 300) // Min minutes threshold
        .map(p => ({
            x: p.a_per_90,
            y: p.g_per_90,
            name: p.player_name
        }));

    new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [{
                data: qualified,
                backgroundColor: COLORS.accent,
                pointRadius: 5,
                pointHoverRadius: 7
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.raw.name}: ${ctx.raw.y.toFixed(2)} G/90, ${ctx.raw.x.toFixed(2)} A/90`
                    }
                },
                legend: { display: false }
            },
            scales: {
                x: { title: { display: true, text: 'Assists per 90' } },
                y: { title: { display: true, text: 'Goals per 90' } }
            }
        }
    });
}

function renderContributionChart() {
    const ctx = document.getElementById('contributionChart').getContext('2d');
    const topContributors = [...window.playerStats]
        .sort((a, b) => (b.goals + b.assists) - (a.goals + a.assists))
        .slice(0, 10);

    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: topContributors.map(p => p.player_name),
            datasets: [
                {
                    label: 'Goals',
                    data: topContributors.map(p => p.goals),
                    backgroundColor: COLORS.accent,
                    stack: 'Stack 0'
                },
                {
                    label: 'Assists',
                    data: topContributors.map(p => p.assists),
                    backgroundColor: COLORS.success,
                    stack: 'Stack 0'
                }
            ]
        },
        options: {
            maintainAspectRatio: false,
            scales: {
                y: { stacked: true },
                x: { stacked: true }
            }
        }
    });
}

function handleSearch(e) {
    const term = e.target.value.toLowerCase();
    applyFilters(term, document.getElementById('team-filter').value);
}

function handleFilter(e) {
    const team = e.target.value;
    applyFilters(document.getElementById('search-input').value.toLowerCase(), team);
}

function applyFilters(searchTerm, teamFilter) {
    filteredData = window.playerStats.filter(p => {
        const matchesSearch = p.player_name.toLowerCase().includes(searchTerm) ||
            p.team_id.toLowerCase().includes(searchTerm);
        const matchesTeam = teamFilter === 'all' || p.team_id === teamFilter;
        return matchesSearch && matchesTeam;
    });

    sortData();
    currentPage = 1;
    renderTable();
}

function handleSort(field) {
    if (currentSort.field === field) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.field = field;
        currentSort.direction = 'desc';
    }
    sortData();
    renderTable();
}

function sortData() {
    filteredData.sort((a, b) => {
        let valA = a[currentSort.field];
        let valB = b[currentSort.field];

        // Handle sorting
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();

        if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
        if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
        return 0;
    });
}

function renderTable() {
    const tbody = document.querySelector('#stats-table tbody');
    tbody.innerHTML = '';

    const start = (currentPage - 1) * ROWS_PER_PAGE;
    const end = start + ROWS_PER_PAGE;
    const pageData = filteredData.slice(start, end);

    pageData.forEach((p, index) => {
        const tr = document.createElement('tr');
        const rank = start + index + 1;

        // Format Metrics
        const g90 = p.g_per_90.toFixed(2);
        const a90 = p.a_per_90.toFixed(2);
        const conv = p.conversion_rate.toFixed(1) + '%';

        tr.innerHTML = `
            <td class="cell-rank">${rank}</td>
            <td>
                <div style="font-weight: 500;">${p.player_name}</div>
                <div style="font-size: 0.75rem; color: #64748b;">${p.jersey_number ? '#' + p.jersey_number : ''}</div>
            </td>
            <td><span class="pill">${p.team_id}</span></td>
            <td class="cell-numeric">${p.games_played}</td>
            <td class="cell-numeric">${p.minutes}</td>
            <td class="cell-numeric" style="color: ${COLORS.textLight}; font-weight: 600;">${p.goals}</td>
            <td class="cell-numeric">${p.assists}</td>
            <td class="cell-numeric">${g90}</td>
            <td class="cell-numeric">${a90}</td>
            <td class="cell-numeric" style="${p.conversion_rate > 20 ? 'color: ' + COLORS.success : ''}">${conv}</td>
            <td class="cell-numeric">${p.shots}</td>
        `;
        tbody.appendChild(tr);
    });

    updatePagination();
    updateSortIcons();
}

function updateSortIcons() {
    document.querySelectorAll('th[data-sort]').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === currentSort.field) {
            th.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

function updatePagination() {
    const totalPages = Math.ceil(filteredData.length / ROWS_PER_PAGE);
    document.getElementById('page-info').textContent = `Page ${currentPage} of ${totalPages || 1}`;
    document.getElementById('prev-page').disabled = currentPage === 1;
    document.getElementById('next-page').disabled = currentPage >= totalPages;
}

function changePage(delta) {
    currentPage += delta;
    renderTable();
}
