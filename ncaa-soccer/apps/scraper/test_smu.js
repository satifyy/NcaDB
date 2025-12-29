const { SidearmParser } = require('@ncaa/parsers');
const fs = require('fs');

async function test() {
    // Load the SMU HTML
    const html = fs.readFileSync('c:\\Users\\p0802\\Documents\\CS\\NcaDB-1\\ncaa-soccer\\data\\raw\\2025-12-29T04-12-22-139Z_SMU_schedule.html', 'utf-8');

    const parser = new SidearmParser();
    const games = await parser.parseSchedule(html, { baseUrl: 'https://smumustangs.com', debug: true });

    console.log('\nSMU Schedule Parse Results:');
    console.log(`Total games: ${games.length}`);
    
    // Check first few games for dates
    games.slice(0, 10).forEach((game, i) => {
        console.log(`Game ${i+1}: ${game.date} - ${game.away_team_name} @ ${game.home_team_name}`);
    });

    // Count how many have the fallback date
    const fallbackCount = games.filter(g => g.date.endsWith('-01-01')).length;
    console.log(`\nGames with fallback date (YYYY-01-01): ${fallbackCount}/${games.length}`);
}

test().catch(console.error);
