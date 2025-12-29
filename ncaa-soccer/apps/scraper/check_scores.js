const fs = require('fs');
const { SidearmParser } = require('../../packages/parsers');

async function test() {
  const html = fs.readFileSync('../../data/raw/2025-12-29T05-20-38-252Z_SMU_schedule.html', 'utf8');
  const parser = new SidearmParser('https://smumustangs.com');
  const games = await parser.parseSchedule(html, false);

  console.log(`Total games: ${games.length}\n`);
  console.log('First 5 games with scores:');
  games.slice(0, 5).forEach((game, i) => {
    console.log(`${i + 1}. ${game.date} - ${game.opponent}`);
    console.log(`   Status: ${game.status}`);
    console.log(`   Score: ${game.home_score}-${game.away_score}`);
    console.log('');
  });
}

test().catch(console.error);
