const fs = require('fs');
const path = require('path');

const scriptPath = path.join(process.cwd(), 'nuxt_data_script.js');
const rawData = fs.readFileSync(scriptPath, 'utf8');
const data = JSON.parse(rawData);

const playerIndex = 4735;
console.log(`Object at index ${playerIndex}:`, JSON.stringify(data[playerIndex], null, 2));

// Check resolved values
const player = data[playerIndex];
// Resolve keys if needed? No, keys are strings in the object usually. 
// But values might be indices.

const resolved = {};
Object.entries(player).forEach(([k, v]) => {
    if (typeof v === 'number' && v < data.length) {
        resolved[k] = data[v];
    } else {
        resolved[k] = v;
    }
});
console.log('Resolved Player:', JSON.stringify(resolved, null, 2));

// Check if stats are here
