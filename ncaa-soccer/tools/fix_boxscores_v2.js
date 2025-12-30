const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const path = 'data/games/2025/games7.csv';
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

const norm = (v) => (v ? String(v).trim() : '');
const isAbsolute = (u) => /^https?:\/\//i.test(u);

const overrides = new Map([
  ['california', 'https://calbears.com'],
  ['cal', 'https://calbears.com'],
  ['southern methodist university', 'https://smumustangs.com'],
  ['smu', 'https://smumustangs.com']
]);

const csv = fs.readFileSync(path, 'utf8');
const rows = parse(csv, { columns: true, skip_empty_lines: true });

// Pass 1: infer domain per team from any absolute URL seen in boxscore_url or schedule_url
const teamDomain = new Map();
const captureDomain = (team, url) => {
  if (!team) return;
  const key = team.toLowerCase();
  if (overrides.has(key)) {
    teamDomain.set(team, overrides.get(key));
    return;
  }
  if (!url || !isAbsolute(url)) return;
  try {
    const origin = new URL(url).origin;
    if (!teamDomain.has(team)) teamDomain.set(team, origin);
  } catch (_) {
    /* ignore bad url */
  }
};

for (const r of rows) {
  const box = norm(r.boxscore_url);
  const sched = norm(r.schedule_url);
  captureDomain(norm(r.home_team_name), box);
  captureDomain(norm(r.away_team_name), box);
  captureDomain(norm(r.home_team_name), sched);
  captureDomain(norm(r.away_team_name), sched);
}

// Pass 2: prefix relative boxscore links using any known domain for either team
for (const r of rows) {
  const box = norm(r.boxscore_url);
  if (box && !isAbsolute(box) && box.startsWith('/')) {
    const homeKey = norm(r.home_team_name).toLowerCase();
    const awayKey = norm(r.away_team_name).toLowerCase();
    const homeDom = overrides.get(homeKey) || teamDomain.get(norm(r.home_team_name));
    const awayDom = overrides.get(awayKey) || teamDomain.get(norm(r.away_team_name));
    const domain = homeDom || awayDom;
    if (domain) {
      r.boxscore_url = `${domain}${box}`;
    }
  }
}

const out = stringify(rows, { header: true, columns: headers });
fs.writeFileSync(path, out);
console.log('Updated boxscore URLs using inferred domains for', teamDomain.size, 'teams');
