const fs = require('fs');

const csv = fs.readFileSync('../../data/games/2025/games.csv', 'utf8');
const lines = csv.split('\n').slice(1).filter(l => l.trim());

const fallbackDates = lines.filter(l => l.includes('2025-01-01'));
const totalGames = lines.length;

const withScores = lines.filter(l => {
  const parts = l.split(',');
  return parts[6] && parts[7] && parts[6] !== '' && parts[7] !== '';
});

console.log(`Total games: ${totalGames}`);
console.log(`Games with 2025-01-01 date: ${fallbackDates.length} (${(fallbackDates.length/totalGames*100).toFixed(1)}%)`);
console.log(`Games with scores: ${withScores.length} (${(withScores.length/totalGames*100).toFixed(1)}%)`);

console.log(`\nSample games with scores:`);
withScores.slice(0, 5).forEach(line => {
  const parts = line.split(',');
  console.log(`  ${parts[1]} - ${parts[2]} vs ${parts[3]}: ${parts[6]}-${parts[7]}`);
});

console.log(`\nSample games without scores (status=final):`);
const finalNoScores = lines.filter(l => {
  const parts = l.split(',');
  return parts[9] === 'final' && (!parts[6] || !parts[7] || parts[6] === '' || parts[7] === '');
});
console.log(`Final games without scores: ${finalNoScores.length}`);
finalNoScores.slice(0, 5).forEach(line => {
  const parts = line.split(',');
  console.log(`  ${parts[1]} - ${parts[2]} vs ${parts[3]} (${parts[9]})`);
});
