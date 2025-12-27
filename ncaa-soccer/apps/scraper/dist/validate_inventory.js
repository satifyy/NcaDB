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
console.log("Starting inventory validation...");
// Path to data
const dataPath = path.resolve(__dirname, '../../../data/teams');
const teamsPath = path.join(dataPath, 'acc_teams.json');
const aliasesPath = path.join(dataPath, 'team_aliases.json');
const resolver = new shared_1.TeamResolver(teamsPath, aliasesPath);
const teams = resolver.getTeams();
console.log(`Loaded ${teams.length} teams.`);
let errorCount = 0;
const teamIds = new Set();
teams.forEach((team, index) => {
    // 1. Zod Schema Validation
    try {
        shared_1.TeamSchema.parse(team);
    }
    catch (e) {
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
}
else {
    console.error(`Validation Failed with ${errorCount} errors.`);
    process.exit(1);
}
//# sourceMappingURL=validate_inventory.js.map