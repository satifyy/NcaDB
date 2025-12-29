"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const schools_1 = require("../config/schools");
const fetcher_1 = require("../utils/fetcher");
async function main() {
    console.log('Inspecting API structure...');
    const fetcher = new fetcher_1.Fetcher({ delayMs: 1000, quiet: true });
    const school = schools_1.accSchools[0]; // SMU
    try {
        const response = await fetcher.get(school.scheduleApiUrl, undefined, {
            headers: {
                'Referer': school.baseUrl,
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        const data = JSON.parse(response);
        if (Array.isArray(data) && data.length > 0) {
            const game = data[0];
            console.log('Keys:', Object.keys(game).join(', '));
            console.log('Boxscore Link:', game.boxscore_link);
            console.log('Game File:', game.game_file);
            console.log('ID:', game.id);
        }
        else {
            console.log('No data found or not an array');
        }
    }
    catch (e) {
        console.error('Error:', e);
    }
}
main();
//# sourceMappingURL=inspect_api_structure.js.map