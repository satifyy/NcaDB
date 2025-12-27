import * as fs from 'fs';
import * as path from 'path';
import { Team } from './schemas/team';

interface AliasMap {
    [key: string]: string[];
}

export class TeamResolver {
    private teams: Team[] = [];
    private aliasMap: Map<string, string> = new Map();

    constructor(
        private teamsPath: string,
        private aliasesPath: string
    ) {
        this.reload();
    }

    reload() {
        if (fs.existsSync(this.teamsPath)) {
            const data = fs.readFileSync(this.teamsPath, 'utf-8');
            this.teams = JSON.parse(data);
        }

        if (fs.existsSync(this.aliasesPath)) {
            const data = fs.readFileSync(this.aliasesPath, 'utf-8');
            const aliasJson: AliasMap = JSON.parse(data);

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

    getTeams(): Team[] {
        return this.teams;
    }

    resolveTeamId(nameOrAlias: string): string | null {
        const normalized = nameOrAlias.trim().toUpperCase();
        return this.aliasMap.get(normalized) || null;
    }
}
