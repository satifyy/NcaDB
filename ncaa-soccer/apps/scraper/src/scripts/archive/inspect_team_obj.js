const fs = require('fs');
const path = require('path');

const scriptPath = path.join(process.cwd(), 'nuxt_data_script.js');
const rawData = fs.readFileSync(scriptPath, 'utf8');
const data = JSON.parse(rawData);

const indices = [4684, 4710];

indices.forEach(idx => {
    console.log(`\nObject at index ${idx}:`, JSON.stringify(data[idx], null, 2));

    // Resolve helper
    const item = data[idx];
    if (typeof item === 'object' && item !== null) {
        const resolved = {};
        Object.entries(item).forEach(([k, v]) => {
            if (typeof v === 'number' && v < data.length) {
                if (typeof data[v] === 'string' || typeof data[v] === 'number') {
                    resolved[k] = data[v];
                } else {
                    resolved[k] = `[Obj ${v}]`;
                }
            } else {
                resolved[k] = v;
            }
        });
        console.log(`Resolved immediate values for ${idx}:`, JSON.stringify(resolved, null, 2));
    }
});
