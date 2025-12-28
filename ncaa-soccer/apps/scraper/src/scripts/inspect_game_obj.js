const fs = require('fs');
const path = require('path');

const scriptPath = path.join(process.cwd(), 'nuxt_data_script.js');
const rawData = fs.readFileSync(scriptPath, 'utf8');
const data = JSON.parse(rawData);

const indices = [4683, 13];

indices.forEach(idx => {
    console.log(`\nObject at index ${idx}:`, JSON.stringify(data[idx], null, 2));

    // Resolve immediate values
    const item = data[idx];
    if (typeof item === 'object' && item !== null) {
        const resolved = {};
        Object.entries(item).forEach(([k, v]) => {
            if (typeof v === 'number' && v < data.length) {
                // If it's a string index, resolve it
                if (typeof data[v] === 'string' || typeof data[v] === 'number') {
                    resolved[k] = data[v];
                } else {
                    resolved[k] = `[Object/Array ${v}]`;
                }
            } else {
                resolved[k] = v;
            }
        });
        console.log(`Resolved immediate values for ${idx}:`, JSON.stringify(resolved, null, 2));
    }
});
