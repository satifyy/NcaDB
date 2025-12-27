
import { SidearmBoxScoreParser } from '@ncaa/parsers';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
    console.log('Verifying Sidearm Box Score Parser...');

    // We need a sample HTML file. 
    // Assuming one isn't saved yet, we'll need to fetch one or mock it.
    // For this script, we'll try to use a mock HTML string that matches the structure 
    // identified by the browser agent.

    const mockHtml = `
      <table class="sidearm-table overall-stats">
        <caption>SMU - Player Stats</caption>
        <thead>
            <tr>
                <th scope="col">Pos</th>
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col">SH</th>
                <th scope="col">SOG</th>
                <th scope="col">G</th>
                <th scope="col">A</th>
                <th scope="col">MIN</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td>FWD</td>
                <td>10</td>
                <td><a href="/sports/mens-soccer/roster/bailey-sparks/1324">Sparks, Bailey</a></td>
                <td>5</td>
                <td>1</td>
                <td>1</td>
                <td>0</td>
                <td>79</td>
            </tr>
            <tr>
                <td>MID</td>
                <td>20</td>
                <td>Other, Player</td>
                <td>0</td>
                <td>0</td>
                <td>0</td>
                <td>0</td>
                <td>45</td>
            </tr>
        </tbody>
    </table>
    `;

    const parser = new SidearmBoxScoreParser();
    const result = parser.parse(mockHtml, {
        teamId: 'SMU',
        sourceUrl: 'http://test.com/game/123'
    });

    console.log(`Parsed ${result.playerStats.length} player stats.`);

    result.playerStats.forEach((stat: any) => {
        console.log(`[${stat.team_id}] #${stat.jersey_number} ${stat.player_name} (Key: ${stat.player_key}) - G:${stat.goals} A:${stat.assists} Min:${stat.minutes}`);
    });
}

main();
