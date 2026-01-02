const fs = require('fs');
const path = require('path');

const scriptPath = path.join(process.cwd(), 'nuxt_data_script.js');
const rawData = fs.readFileSync(scriptPath, 'utf8');
const data = JSON.parse(rawData);

// Scan for objects with 'players', 'id', 'name'
console.log('Scanning for Team objects...');
for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        // Check keys exist (values can be anything)
        const hasPlayers = 'players' in item;
        const hasId = 'id' in item;
        const hasName = 'name' in item;

        if (hasPlayers && hasId && hasName) {
            // Check if players is an array reference
            const playersVal = item['players'];
            // resolve playersVal if it's a number
            let playersArray = null;
            if (typeof playersVal === 'number' && typeof data[playersVal] === 'object' && Array.isArray(data[playersVal])) {
                playersArray = data[playersVal];
            } else if (Array.isArray(playersVal)) {
                playersArray = playersVal;
            }

            if (playersArray) {
                // Must likely be a team
                // Resolve name
                let name = item['name'];
                if (typeof name === 'number') name = data[name];

                let id = item['id'];
                if (typeof id === 'number') id = data[id];

                console.log(`Found candidate Team at index ${i}: ID=${id}, Name=${name}, PlayersCount=${playersArray.length}`);
            }
        }
    }
}
