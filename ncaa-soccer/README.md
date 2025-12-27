# NCAA Soccer Scraper Monorepo

## Overview
This monorepo contains the infrastructure for scraping, parsing, and storing NCAA men's soccer data.

## Structure
- `apps/scraper`: Orchestration and runners.
- `apps/ui`: Web interface (stubbed).
- `packages/shared`: Data contracts, schemas, and helpers.
- `packages/parsers`: Parser interfaces and registry.
- `packages/storage`: Storage adapters (CSV).

## Data Contracts
### Team
Represents a university's men's soccer program.
- `team_id`: Unique canonical ID (e.g., "CLEMSON").
- `schedule_url`: Official schedule page URL.
- `parser_key`: Key mapping to the parser logic (e.g., "sidearm_std").

### IDs
- **Game ID**: Derived from `Base64(date:homeID:awayID)`.
- **Player Key**: `teamID:normalizedName`.

## Usage
### Build
```bash
npm install
npm run build
```

### Validate Inventory
To verify that all registered teams have valid metadata and schedule URLs:
```bash
node apps/scraper/dist/validate_inventory.js
```
The script requires `data/teams/acc_teams.json` to exist and be populated.
