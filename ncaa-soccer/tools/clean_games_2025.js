const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const path = 'data/games/2025/games.csv';
const headers = [
  'game_id',
  'date',
  'home_team_name',
  'away_team_name',
  'home_team_ranked',
  'away_team_ranked',
  'home_score',
  'away_score',
  'location_type',
  'status',
  'schedule_url',
  'boxscore_url',
  'dedupe_key'
];

const norm = (val) => (val ? String(val).replace(/\s+/g, ' ').trim() : '');
const makeKey = (date, home, away) => {
  const parts = [norm(home), norm(away)].sort();
  return `${date}-${parts[0].replace(/\s+/g, '-')}-${parts[1].replace(/\s+/g, '-')}`;
};

const raw = fs.readFileSync(path, 'utf8');
const records = parse(raw, { columns: true, skip_empty_lines: true });
const cleanedMap = new Map();
let dropped = 0;

for (const r of records) {
  const home = norm(r.home_team_name);
  const away = norm(r.away_team_name);
  const date = norm(r.date);

  const hasUnknown =
    !home ||
    !away ||
    /unknown/i.test(home) ||
    /unknown/i.test(away) ||
    /home team/i.test(home) ||
    /home team/i.test(away) ||
    /away team/i.test(home) ||
    /away team/i.test(away);

  const isCalOrSmU =
    /california/i.test(home) ||
    /california/i.test(away) ||
    /southern methodist university/i.test(home) ||
    /southern methodist university/i.test(away) ||
    /\bSMU\b/i.test(home) ||
    /\bSMU\b/i.test(away);

  if (hasUnknown) {
    dropped++;
    continue;
  }
  if (isCalOrSmU && date === '2025-01-01') {
    dropped++;
    continue;
  }

  const row = {
    game_id: `sidearm-${makeKey(date, home, away)}`,
    date,
    home_team_name: home,
    away_team_name: away,
    home_team_ranked: String(r.home_team_ranked).toLowerCase() === 'true' ? 'true' : 'false',
    away_team_ranked: String(r.away_team_ranked).toLowerCase() === 'true' ? 'true' : 'false',
    home_score: r.home_score ? String(r.home_score).trim() : '',
    away_score: r.away_score ? String(r.away_score).trim() : '',
    location_type: r.location_type || 'unknown',
    status: r.status || 'scheduled',
    schedule_url: norm(r.schedule_url),
    boxscore_url: norm(r.boxscore_url),
    dedupe_key: makeKey(date, home, away)
  };

  cleanedMap.set(row.dedupe_key, row);
}

const cleaned = Array.from(cleanedMap.values()).sort((a, b) => a.date.localeCompare(b.date));
fs.writeFileSync(path, stringify(cleaned, { header: true, columns: headers }));
console.log(`Original ${records.length} Kept ${cleaned.length} Dropped ${dropped} Deduped ${records.length - cleaned.length}`);
