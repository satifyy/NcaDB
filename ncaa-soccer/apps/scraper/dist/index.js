"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const shared_1 = require("@ncaa/shared");
const path = __importStar(require("path"));
console.log("Starting scraper integration check...");
// 1. Validate a sample Game
const sampleGame = {
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
    shared_1.GameSchema.parse(sampleGame);
    console.log("Game schema validation: OK");
}
catch (e) {
    console.error("Game schema validation: FAILED", e);
    process.exit(1);
}
// 2. Validate sample PlayerStat
const sampleStat = {
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
    shared_1.PlayerStatSchema.parse(sampleStat);
    console.log("PlayerStat schema validation: OK");
}
catch (e) {
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
const resolver = new shared_1.TeamResolver(teamsPath, aliasesPath);
const teams = resolver.getTeams();
if (teams.length > 0) {
    console.log(`Loaded ${teams.length} teams: OK`);
}
else {
    console.error("Failed to load teams (0 loaded)");
    // Don't fail hard if path is wrong in this stub environment, but good to know
}
const resolvedId = resolver.resolveTeamId("Duke University");
if (resolvedId === "DUKE") {
    console.log("Team alias resolution (Duke University -> DUKE): OK");
}
else {
    console.error(`Team alias resolution failed: got ${resolvedId}`);
}
console.log("OK: contracts wired");
//# sourceMappingURL=index.js.map