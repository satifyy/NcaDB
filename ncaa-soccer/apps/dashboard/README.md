# NCAA Soccer Dashboard

A modern, high-performance dashboard for analyzing NCAA soccer player statistics. Built with **React 18** and **Vite**, featuring a premium dark-mode UI and interactive visualizations.

## 🚀 Features

### Core Experience
- **Premium Dark UI**: A sleek, data-first interface aimed at professional analysis.
- **Fast Performance**: Built on Vite for instant server start and HMR.
- **Responsive Design**: Adapts seamlessy to all screen sizes.

### Analytics & Visualizations
- **KPI Overview**: Instant view of total players, goals, top scorer, and efficiency metrics.
- **Interactive Charts**:
    - **Top Scorers**: Bar chart of the top 10 goal scorers.
    - **Efficiency Scatter**: Correlations between shots taken and goals scored, color-coded by conversion rate.
    - **Goal Contributions**: Stacked analysis of Goals + Assists.
- **Advanced Data Table**:
    - **Sorting**: Multi-column sorting capabilities.
    - **Pagination**: Efficiently browse through thousands of players.
    - **Real-time Search**: Filter instantly by player name or team.
    - **Team Filtering**: Isolate stats for specific universities.

## 🛠 Tech Stack

- **Framework**: React 18 + Vite
- **Language**: TypeScript
- **Styling**: Vanilla CSS (CSS Variables & Modules) for zero-runtime overhead.
- **Charts**: Chart.js + react-chartjs-2
- **Icons**: Lucide React
- **Data**: JSON (Pre-processed from CSV)

## 🏃‍♂️ Getting Started

### Prerequisites
- Node.js (v18+)
- npm or pnpm

### Installation

1. Navigate to the dashboard directory:
   ```bash
   cd apps/dashboard
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Open your browser to the local URL (usually `http://localhost:5173`).

## 📊 Data Pipeline

The dashboard consumes a static JSON file generated from the scraped CSV data. This ensures fast load times without parsing CSV in the browser.

**Source**: `data/player_stats/2025/aggregated_player_stats.csv`  
**Destination**: `apps/dashboard/src/data/player_stats.json`

To regenerate the data:

```bash
# From the root of the monorepo
npx tsx apps/scraper/src/scripts/generate_dashboard_data.ts
```

## 📂 Project Structure

```
apps/dashboard/
├── src/
│   ├── components/
│   │   ├── Dashboard/    # Analytics widgets (Charts, Tables, KPIs)
│   │   └── Layout/       # Structural components (Header, etc.)
│   ├── data/             # Generated JSON data
│   ├── styles/           # Global styles and CSS variables
│   ├── types.ts          # TypeScript interfaces
│   └── App.tsx           # Main application entry
├── index.html            # Entry HTML
└── vite.config.ts        # Vite configuration
```

## 🎨 Customization

### Theme
Colors and spacing are defined in `src/styles/variables.css`. You can easily adjust the `--color-accent-primary` to change the brand color.

### Adding New Metrics
1. Update `src/types.ts` to include the new field.
2. Update `apps/scraper/src/scripts/generate_dashboard_data.ts` to map the CSV column to the JSON property.
3. Regenerate data and use the new field in your components.
