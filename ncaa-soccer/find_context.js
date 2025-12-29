
const fs = require('fs');
const path = require('path');

const filePath = path.join(process.cwd(), 'debug_duke_schedule_clicked.html');
const content = fs.readFileSync(filePath, 'utf-8');

const search = 'boxscore';
let index = content.indexOf(search);
let count = 0;

while (index !== -1 && count < 5) {
    console.log(`\nMatch ${count + 1}:`);
    const start = Math.max(0, index - 500);
    const end = Math.min(content.length, index + 500);
    console.log(content.substring(start, end));

    index = content.indexOf(search, index + 1);
    count++;
}
