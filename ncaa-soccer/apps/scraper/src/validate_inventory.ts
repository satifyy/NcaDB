import { TeamSchema, TeamResolver, Team } from '@ncaa/shared';
import * as fs from 'fs';
import * as path from 'path';
import { TEAMS_DIR, TEAM_ALIASES } from '@ncaa/storage';

console.log("Starting inventory validation...");

// Path to data
const dataPath = TEAMS_DIR;
const aliasesPath = TEAM_ALIASES;

// Every conference inventory, not just the ACC, so a discovery run is checked too.
// `d1_msoc_teams.json` is their union (`p5_msoc_teams.json` was its name while the
// dataset was five conferences), so validating it as well would double-report, and
// `test_teams.json` is a hand-written fixture rather than a real inventory.
const NOT_INVENTORIES = new Set(['d1_msoc_teams.json', 'p5_msoc_teams.json', 'test_teams.json']);
const inventoryFiles = fs
    .readdirSync(dataPath)
    .filter(file => file.endsWith('_teams.json') && !NOT_INVENTORIES.has(file))
    .sort();

const teams: Team[] = [];
for (const file of inventoryFiles) {
    const loaded = new TeamResolver(path.join(dataPath, file), aliasesPath).getTeams();
    console.log(`  ${file}: ${loaded.length} teams`);
    teams.push(...loaded);
}

console.log(`Loaded ${teams.length} teams from ${inventoryFiles.length} inventories.`);

let errorCount = 0;
const teamIds = new Set<string>();

teams.forEach((team, index) => {
    // 1. Zod Schema Validation
    try {
        TeamSchema.parse(team);
    } catch (e) {
        console.error(`[Team #${index}] Schema validation failed:`, e);
        errorCount++;
    }

    // 2. Uniqueness Check
    if (teamIds.has(team.team_id)) {
        console.error(`[Team ${team.team_id}] Duplicate Team ID detected!`);
        errorCount++;
    }
    teamIds.add(team.team_id);

    // 3. Metadata Completeness Check (Custom Business Logic)
    if (!team.schedule_url) {
        console.error(`[Team ${team.team_id}] Missing schedule_url`);
        errorCount++;
    }
    if (!team.platform_guess) {
        console.error(`[Team ${team.team_id}] Missing platform_guess`);
        errorCount++;
    }
    if (!team.parser_key) {
        console.error(`[Team ${team.team_id}] Missing parser_key`);
        errorCount++;
    }
});

if (errorCount === 0) {
    console.log("Validation Passed: All teams have valid schemas and required metadata.");
    process.exit(0);
} else {
    console.error(`Validation Failed with ${errorCount} errors.`);
    process.exit(1);
}
