const fs = require('fs');
const path = require('path');

// Mock window
const window = {
    __NUXT__: {},
    location: { search: '' },
};
const document = {
    // Mock document if needed
    querySelector: () => null,
    getElementById: () => null,
};

// Read script
const scriptPath = path.join(process.cwd(), 'nuxt_script.js');
const scriptContent = fs.readFileSync(scriptPath, 'utf8');

try {
    // Execute script
    eval(scriptContent);

    // Check results
    console.log('Keys in window.__NUXT__:', Object.keys(window.__NUXT__));

    // Save extraction
    fs.writeFileSync('unc_nuxt_dump.json', JSON.stringify(window.__NUXT__, null, 2));
    console.log('Saved window.__NUXT__ to unc_nuxt_dump.json');
} catch (e) {
    console.error('Eval failed:', e);
}
