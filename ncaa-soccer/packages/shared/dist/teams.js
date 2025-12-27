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
exports.TeamResolver = void 0;
const fs = __importStar(require("fs"));
class TeamResolver {
    constructor(teamsPath, aliasesPath) {
        this.teamsPath = teamsPath;
        this.aliasesPath = aliasesPath;
        this.teams = [];
        this.aliasMap = new Map();
        this.reload();
    }
    reload() {
        if (fs.existsSync(this.teamsPath)) {
            const data = fs.readFileSync(this.teamsPath, 'utf-8');
            this.teams = JSON.parse(data);
        }
        if (fs.existsSync(this.aliasesPath)) {
            const data = fs.readFileSync(this.aliasesPath, 'utf-8');
            const aliasJson = JSON.parse(data);
            this.aliasMap.clear();
            for (const [canonical, aliases] of Object.entries(aliasJson)) {
                this.aliasMap.set(canonical.toUpperCase(), canonical);
                for (const alias of aliases) {
                    this.aliasMap.set(alias.toUpperCase(), canonical);
                }
            }
            // Also map canonical names from teams list itself
            for (const team of this.teams) {
                this.aliasMap.set(team.name_canonical.toUpperCase(), team.team_id);
                if (team.aliases) {
                    for (const alias of team.aliases) {
                        this.aliasMap.set(alias.toUpperCase(), team.team_id);
                    }
                }
            }
        }
    }
    getTeams() {
        return this.teams;
    }
    resolveTeamId(nameOrAlias) {
        const normalized = nameOrAlias.trim().toUpperCase();
        return this.aliasMap.get(normalized) || null;
    }
}
exports.TeamResolver = TeamResolver;
//# sourceMappingURL=teams.js.map