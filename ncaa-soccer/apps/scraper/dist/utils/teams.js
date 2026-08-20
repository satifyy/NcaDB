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
exports.TEAMS_DIR = exports.DEFAULT_ALIASES_PATH = exports.DEFAULT_TEAMS_PATH = void 0;
exports.loadTeams = loadTeams;
exports.loadAllTeams = loadAllTeams;
exports.buildTeamNameResolver = buildTeamNameResolver;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const parsers_1 = require("@ncaa/parsers");
exports.DEFAULT_TEAMS_PATH = path.resolve(__dirname, '../../../../data/teams/acc_teams.json');
exports.DEFAULT_ALIASES_PATH = path.resolve(__dirname, '../../../../data/teams/team_aliases.json');
function loadTeams(teamsPath = exports.DEFAULT_TEAMS_PATH) {
    if (!fs.existsSync(teamsPath)) {
        throw new Error(`Teams JSON not found at ${teamsPath}`);
    }
    return JSON.parse(fs.readFileSync(teamsPath, 'utf8'));
}
exports.TEAMS_DIR = path.resolve(__dirname, '../../../../data/teams');
/**
 * Every school across every conference inventory, de-duplicated by `team_id`.
 *
 * Stages that work off `games.csv` rather than one conference's roster need all of
 * them: a box score fetched from a Big Ten game still has to resolve that school's name
 * and know which platform serves it. Loading only `acc_teams.json` leaves every other
 * conference without aliases and routes its WMT sites down the HTML path.
 */
function loadAllTeams(teamsDir = exports.TEAMS_DIR) {
    const byId = new Map();
    for (const file of fs.readdirSync(teamsDir).sort()) {
        if (!file.endsWith('_teams.json') || file === 'test_teams.json')
            continue;
        try {
            for (const team of loadTeams(path.join(teamsDir, file))) {
                if (team.team_id && !byId.has(team.team_id))
                    byId.set(team.team_id, team);
            }
        }
        catch {
            /* not a usable inventory */
        }
    }
    return [...byId.values()];
}
/**
 * Builds a resolver that maps every known spelling of a team — including the
 * mascot-only names some sites store — onto the canonical name used in the dataset.
 *
 * `team_aliases.json` is keyed by `team_id`, so it is joined back to
 * `acc_teams.json` to get the display name each alias should collapse to.
 */
function buildTeamNameResolver(teams, aliasesPath = exports.DEFAULT_ALIASES_PATH) {
    const canonicalById = new Map(teams.map(team => [team.team_id, team.name_canonical]));
    const map = {};
    for (const team of teams) {
        map[team.name_canonical] = [...(team.aliases || [])];
    }
    if (fs.existsSync(aliasesPath)) {
        const byTeamId = JSON.parse(fs.readFileSync(aliasesPath, 'utf8'));
        for (const [teamId, aliases] of Object.entries(byTeamId)) {
            const canonical = canonicalById.get(teamId);
            if (!canonical)
                continue;
            map[canonical] = [...(map[canonical] || []), ...aliases];
        }
    }
    return new parsers_1.TeamNameResolver(map);
}
//# sourceMappingURL=teams.js.map