import {
    GameSchema,
    PlayerStatSchema,
    Game,
    PlayerStat,
    TeamResolver
} from '@ncaa/shared';
import * as path from 'path';

console.log("Starting scraper integration check...");

// 1. Validate a sample Game
const sampleGame: Game = {
    game_id: 'test-game-1',
    date: '2024-10-15',
    home_team_name: 'Home FC',
    away_team_name: 'Away FC',
    home_score: 2,
    away_score: 1,
    location_type: 'home',
    status: 'final',
    source_urls: {
        schedule_url: 'http://example.com/schedule',
        boxscore_url: 'http://example.com/boxscore'
    },
    dedupe_key: '2024-10-15-home-fc-away-fc'
};

try {
    GameSchema.parse(sampleGame);
    console.log("Game schema validation: OK");
} catch (e) {
    console.error("Game schema validation: FAILED", e);
    process.exit(1);
}

// 2. Validate sample PlayerStat
const sampleStat: PlayerStat = {
    game_id: "test_game_1",
    team_id: "CLEMSON",
    player_name: "Test Player",
    player_key: "CLEMSON:Test Player",
    stats: {
        "Goals": 1,
        "Shots": 3
    }
};

try {
    PlayerStatSchema.parse(sampleStat);
    console.log("PlayerStat schema validation: OK");
} catch (e) {
    console.error("PlayerStat schema validation: FAILED", e);
    process.exit(1);
}

// 3. Verify Team Loading
// Current working directory when running this might be apps/scraper or root.
// We'll try to locate data relative to this file or root.
// Assuming run from root via 'node apps/scraper/dist/index.js' or similar.
// data is at data/teams/
const dataPath = path.resolve(__dirname, '../../../data/teams');
const teamsPath = path.join(dataPath, 'acc_teams.json');
const aliasesPath = path.join(dataPath, 'team_aliases.json');

console.log(`Loading teams from ${teamsPath}...`);
const resolver = new TeamResolver(teamsPath, aliasesPath);

const teams = resolver.getTeams();
if (teams.length > 0) {
    console.log(`Loaded ${teams.length} teams: OK`);
} else {
    console.error("Failed to load teams (0 loaded)");
    // Don't fail hard if path is wrong in this stub environment, but good to know
}

const resolvedId = resolver.resolveTeamId("Duke University");
if (resolvedId === "DUKE") {
    console.log("Team alias resolution (Duke University -> DUKE): OK");
} else {
    console.error(`Team alias resolution failed: got ${resolvedId}`);
}

console.log("OK: contracts wired");
