const fs = require('fs');
const path = require('path');

const scriptPath = path.join(process.cwd(), 'nuxt_data_script.js');
const rawData = fs.readFileSync(scriptPath, 'utf8');

try {
    const data = JSON.parse(rawData);
    console.log(`Parsed JSON. Array length: ${data.length}`);

    // Step 1: Find "Cordes" index
    let cordesIndex = -1;
    for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (typeof item === 'string' && item.includes('Cordes') && !item.includes('<')) { // meaningful string
            console.log(`Found 'Cordes' at index ${i}: "${item}"`);
            cordesIndex = i;
            break; // Find the first match for now
        }
    }

    if (cordesIndex !== -1) {
        console.log(`Searching for objects referencing index ${cordesIndex}...`);
        for (let i = 0; i < data.length; i++) {
            const item = data[i];
            if (typeof item === 'object' && item !== null) {
                // Check values
                Object.values(item).forEach(val => {
                    if (val === cordesIndex) {
                        console.log(`Found reference to ${cordesIndex} in object at index ${i}:`, JSON.stringify(item));

                        // Let's assume this object is the 'Player' object.
                        // We also want to find who references THIS object (index i).
                        findReferences(data, i);
                    }
                });
            }
        }
    }

    function findReferences(data, targetIndex) {
        console.log(`Searching for references to object ${targetIndex}...`);
        for (let i = 0; i < data.length; i++) {
            const item = data[i];
            if (typeof item === 'object' && item !== null) {
                // Check if any value matches targetIndex
                Object.values(item).forEach(val => {
                    if (val === targetIndex) {
                        console.log(` -> Cited by object at index ${i}:`, JSON.stringify(item));
                    }
                    // Also check arrays
                    if (Array.isArray(val)) {
                        if (val.includes(targetIndex)) {
                            console.log(` -> Cited by array in object at index ${i}:`, JSON.stringify(item));
                        }
                    }
                });
                if (Array.isArray(item)) {
                    if (item.includes(targetIndex)) {
                        console.log(` -> Cited by array at index ${i}: [Array]`);
                    }
                }
            }
        }
    }

} catch (e) {
    console.error('Parse failed:', e);
}
