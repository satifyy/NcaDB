import React from 'react';
import { Team, TeamSchema } from '@ncaa/shared';

export const TeamCard: React.FC<{ team: Team }> = ({ team }) => {
    return (
        <div>
            <h1>{team.name_canonical}</h1>
            <p>ID: {team.team_id}</p>
            <p>Conference: {team.conference}</p>
        </div>
    );
};

// Simple smoke test for type usage
const dummyTeam: Team = {
    team_id: "SMU",
    name_canonical: "SMU",
    conference: "ACC",
    sport: "msoc",
    aliases: ["Southern Methodist"]
};

// Validate it validates
try {
    TeamSchema.parse(dummyTeam);
    console.log("UI: TeamSchema validation passed");
} catch (e) {
    console.error("UI: TeamSchema validation failed");
}

export const App = () => {
    return <TeamCard team={dummyTeam} />
};
