
const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync('debug_script_35_raw.js', 'utf-8');

let data;
try {
    data = JSON.parse(raw);
} catch (e) {
    try {
        data = eval(raw);
    } catch (e2) {
        console.error("Failed to parse", e2);
        process.exit(1);
    }
}

function resolve(idx) {
    if (typeof idx !== 'number') return idx;
    if (idx >= data.length) return null;
    return data[idx];
}

// Recursively resolve an object's properties
function deepResolve(obj, depth = 0) {
    if (depth > 2) return obj; // Prevent infinite recursion
    if (Array.isArray(obj)) {
        return obj.map(item => deepResolve(resolve(item), depth + 1));
    }
    if (obj && typeof obj === 'object') {
        const result = {};
        for (const [key, val] of Object.entries(obj)) {
            const resolvedVal = resolve(val);
            // Only recurse into specific fields to avoid circular refs or huge dumps
            if (['result', 'opponent', 'date', 'location'].includes(key)) {
                result[key] = deepResolve(resolvedVal, depth + 1);
            } else {
                result[key] = resolvedVal;
            }
        }
        return result;
    }
    return obj;
}

// Find root config object containing "schedule" index
let rootConfig = data.find(item => item && typeof item === 'object' && item['schedule']);

if (!rootConfig) {
    console.log("Could not find root config with 'schedule'");
} else {
    // 1. Get schedule index
    const scheduleIdx = rootConfig['schedule'];
    const scheduleData = resolve(scheduleIdx);
    console.log("Schedule Data (Keys):", Object.keys(scheduleData));

    // 2. Schedule data has "schedules"
    const schedulesIdx = scheduleData['schedules'];
    const schedulesContainer = resolve(schedulesIdx);

    // 3. Find list key
    const scheduleListKey = Object.keys(schedulesContainer)[0];
    console.log("Schedule List Key:", scheduleListKey);

    const scheduleListIdx = schedulesContainer[scheduleListKey];
    const scheduleList = resolve(scheduleListIdx);

    // 4. Get games array
    const gameIndices = scheduleList.games;
    console.log(`Found ${gameIndices ? gameIndices.length : 0} games.`);

    if (gameIndices) {
        const parsedGames = gameIndices.map(gameIdx => {
            return deepResolve(resolve(gameIdx));
        });

        // Print first game to check structure
        console.log("Sample Game 1:", JSON.stringify(parsedGames[0], null, 2));

        // Find a scored game to prove we have scores
        const scoredGame = parsedGames.find(g => {
            return g.result && (g.result.team_score || g.result.opponent_score);
        });

        if (scoredGame) {
            console.log("\n--- FOUND SCORED GAME ---");
            console.log("Date:", scoredGame.date);
            console.log("Opponent:", scoredGame.opponent ? scoredGame.opponent.title : 'Unknown');
            console.log("Score:", scoredGame.result.team_score, "-", scoredGame.result.opponent_score);
            console.log("Boxscore URL:", scoredGame.result.boxscore);
        } else {
            console.log("\nNo scored games found in this data.");
        }
    }
}
