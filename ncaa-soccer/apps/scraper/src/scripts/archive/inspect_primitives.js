const fs = require('fs');
const path = require('path');

const scriptPath = path.join(process.cwd(), 'nuxt_data_script.js');
const rawData = fs.readFileSync(scriptPath, 'utf8');
const data = JSON.parse(rawData);

const indices = [162, 598, 4747];
indices.forEach(i => {
    console.log(`data[${i}]:`, data[i], `(Type: ${typeof data[i]})`);
});
