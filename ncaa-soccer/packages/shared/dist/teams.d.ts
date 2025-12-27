import { Team } from './schemas/team';
export declare class TeamResolver {
    private teamsPath;
    private aliasesPath;
    private teams;
    private aliasMap;
    constructor(teamsPath: string, aliasesPath: string);
    reload(): void;
    getTeams(): Team[];
    resolveTeamId(nameOrAlias: string): string | null;
}
//# sourceMappingURL=teams.d.ts.map