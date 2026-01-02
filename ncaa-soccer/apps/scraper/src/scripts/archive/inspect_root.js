const fs = require('fs');
const path = require('path');

const scriptPath = path.join(process.cwd(), 'nuxt_data_script.js');
const rawData = fs.readFileSync(scriptPath, 'utf8');
const data = JSON.parse(rawData);

// Resolves a value (if number < length, it's an index)
// But for parent finding we don't need resolve, we match indices.

function findParents(targetIndex) {
    const parents = [];
    for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (typeof item === 'object' && item !== null) {
            let found = false;
            Object.values(item).forEach(val => {
                if (val === targetIndex) found = true;
                if (Array.isArray(val) && val.includes(targetIndex)) found = true;
            });
            if (Array.isArray(item) && item.includes(targetIndex)) found = true;

            if (found) parents.push(i);
        }
    }
    return parents;
}

let current = 4722; // Players array
const trace = [current];

console.log(`Tracing parents of ${current}...`);
for (let step = 0; step < 5; step++) {
    const parents = findParents(current);
    if (parents.length === 0) {
        console.log(`No parents found for ${current}. Reached root?`);
        break;
    }
    console.log(`Parents of ${current}:`, parents);
    // Print the parent object to see what it is
    const parentObj = data[parents[0]];
    console.log(`Parent[0] (${parents[0]}) content:`, JSON.stringify(parentObj).substring(0, 300));

    current = parents[0];
    trace.push(current);
}
