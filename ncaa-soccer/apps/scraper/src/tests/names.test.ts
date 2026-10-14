/**
 * Decorations sites hang on a team name, and which of them `cleanTeamName` has to strip.
 *
 * Every marker left on a name makes a second team out of one: "(rv) Delaware" and
 * "Delaware" are stored as two schools, their games never dedupe, and their box scores
 * split across two rows in the dashboard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTeamName, TeamNameResolver, SidearmBoxScoreParser } from '@ncaa/parsers';

test('strips leading rank markers', () => {
    for (const [raw, name] of [
        ['No. 7 Duke', 'Duke'],
        ['#3 NC State', 'NC State'],
        ['(9) North Carolina', 'North Carolina'],
        ['#24/RV University of Virginia', 'University of Virginia'],
        ['#2 Seed West Virginia', 'West Virginia'],
        ['#17 #2 Seed West Virginia', 'West Virginia']
    ] as const) {
        const cleaned = cleanTeamName(raw);
        assert.equal(cleaned.name, name, raw);
        assert.equal(cleaned.ranked, true, `${raw} should be flagged ranked`);
    }
});

test('strips parenthesised rank and receiving-votes markers', () => {
    // These lead with the paren rather than the number, which a number-first pattern
    // walks straight past — leaving the decoration on the name.
    for (const [raw, name] of [
        ['(#8 seed) Portland', 'Portland'],
        ['(rv) Delaware', 'Delaware'],
        ['(RV) Washington', 'Washington']
    ] as const) {
        assert.equal(cleanTeamName(raw).name, name, raw);
        assert.equal(cleanTeamName(raw).ranked, true, raw);
    }
});

test('strips bracket ranks and bare receiving-votes prefixes', () => {
    for (const [raw, name] of [
        ['[11] No. 5 Bryant', 'Bryant'],
        ['[3] Duke', 'Duke'],
        ['RV San Francisco', 'San Francisco'],
        // Residue from rows scraped before "(#4 seed)" was handled, still on disk.
        ['seed) Kansas City', 'Kansas City']
    ] as const) {
        assert.equal(cleanTeamName(raw).name, name, raw);
    }
});

test('strips fixture qualifiers, spelled out or abbreviated', () => {
    for (const [raw, name] of [
        ['Saint Louis (Scrimmage)', 'Saint Louis'],
        ['St. Bonaventure (EX)', 'St. Bonaventure'],
        ['CSUN (Exh.)', 'CSUN'],
        ['Duke (Scrim.)', 'Duke']
    ] as const) {
        const cleaned = cleanTeamName(raw);
        assert.equal(cleaned.name, name, raw);
        assert.equal(cleaned.exhibition, true, `${raw} should be flagged an exhibition`);
    }
});

test('a tournament round is a qualifier but not an exhibition', () => {
    const cleaned = cleanTeamName('Michigan (NCAA First Round)');
    assert.equal(cleaned.name, 'Michigan');
    assert.equal(cleaned.hadQualifier, true);
    assert.equal(cleaned.exhibition, false);
});

test('leaves undecorated names untouched', () => {
    for (const name of ['Boston University', 'Texas A&M', "Saint Mary's College of California", 'Duke']) {
        assert.equal(cleanTeamName(name).name, name);
    }
    assert.equal(cleanTeamName('Clemson * *').name, 'Clemson');
});


test('strips poll lists, brackets and bullets a school prefixes an opponent with', () => {
    // Each of these made a second school out of one: an undecorated name never matches
    // the decorated row, so the fixture never dedupes and both sides get a rating.
    for (const [raw, name] of [
        ['No. 12/13/17 Virginia', 'Virginia'],
        ['No. RV/24/13 Louisville', 'Louisville'],
        ['[9/4] Louisville', 'Louisville'],
        ['[RV/24] Xavier', 'Xavier'],
        ['14/9 UMass Lowell', 'UMass Lowell'],
        ['#37/- Boston College', 'Boston College'],
        ['No .13 Air Force', 'Air Force'],
        ['(#2N) Sacramento State', 'Sacramento State']
    ] as const) {
        assert.equal(cleanTeamName(raw).name, name, raw);
        assert.equal(cleanTeamName(raw).ranked, true, `${raw} should be flagged ranked`);
    }

    // A bullet is a separator, not a ranking, so it is stripped without claiming one.
    assert.equal(cleanTeamName('• Fort Wayne').name, 'Fort Wayne');
    assert.equal(cleanTeamName('• Fort Wayne').ranked, false);
});

test('decodes the HTML entities that reach a team name', () => {
    // Sidearm writes "William &amp; Mary" into its markup, and the entity survives into
    // the stored name, where nothing matches it against the school it names.
    assert.equal(cleanTeamName('William &amp; Mary').name, 'William & Mary');
    assert.equal(cleanTeamName('Mount St. Mary&#039;s').name, "Mount St. Mary's");
    assert.equal(cleanTeamName('Texas A&M').name, 'Texas A&M', 'a real ampersand is left alone');
});

test('strips a round hung on the opponent, and only after a separator', () => {
    for (const [raw, name] of [
        ['Boston College - ACC Semifinals', 'Boston College'],
        ['Memphis -- Wolstein Classic', 'Memphis'],
        ['Charlotte/Alumni Weekend', 'Charlotte'],
        ['Xavier -- at IU Classic', 'Xavier']
    ] as const) {
        assert.equal(cleanTeamName(raw).name, name, raw);
    }
    // No separator, no strip: these are the schools' actual names.
    for (const name of ['Cal Poly SLO', "Saint Mary's (CA)", 'UC Irvine', 'Loyola Marymount']) {
        assert.equal(cleanTeamName(name).name, name);
    }
});

test('recognises the abbreviated exhibition marker, not just the spelled-out one', () => {
    // "(Exhib.)" fell between the two patterns: too long for the short list, too short to
    // match "exhibition". An unflagged friendly is a second game on a team's calendar,
    // which is exactly what the schedule-based alias rules must not see.
    for (const raw of ['Western Iowa Tech (Exhib.)', 'St. Bonaventure (EX)', 'CSUN (Exh.)', 'Butler (Exhibition)']) {
        assert.equal(cleanTeamName(raw).exhibition, true, raw);
    }
    assert.equal(cleanTeamName('Duke').exhibition, false);
});

test('a short form that fits two schools resolves to neither', () => {
    // Dropping "College" from Boston College and "University" from Boston University both
    // give "Boston". Answering with whichever was registered first is how Lehigh's
    // Patriot League fixtures against Boston University were filed as Boston College,
    // with identical scores, across five seasons.
    const resolver = new TeamNameResolver({
        'Boston College': ['BC'],
        'Boston University': [],
        Clemson: [],
        Kentucky: [],
        'Northern Kentucky': [],
        Pacific: ['University of the Pacific']
    });

    assert.equal(resolver.lookup('Boston'), null, 'ambiguous, so unresolved');

    // Everything unambiguous still resolves, in both directions.
    assert.equal(resolver.lookup('Boston College'), 'Boston College');
    assert.equal(resolver.lookup('Boston University'), 'Boston University');
    assert.equal(resolver.lookup('BC'), 'Boston College');
    assert.equal(resolver.lookup('Clemson University'), 'Clemson');
    assert.equal(resolver.lookup('University of Kentucky'), 'Kentucky');
    assert.equal(resolver.lookup('Northern Kentucky'), 'Northern Kentucky');
    assert.equal(resolver.lookup('University of the Pacific'), 'Pacific');
    assert.equal(resolver.lookup('Pacific'), 'Pacific');
});

test('a player table without a minutes column is still a player table', () => {
    // William & Mary publishes "Pos, #, Player, SH, SOG, G, A" — seven columns, no
    // minutes. The positional reader identified a player table by counting eight or more
    // columns and then read fixed offsets out of it, so a layout that omits one column
    // broke both halves at once: every row was discarded and the game was logged as
    // having no player table, when it had two.
    const html = `
        <table class="sidearm-table overall-stats">
            <caption>W&amp;M - Player Stats</caption>
            <thead><tr><th>Pos</th><th>#</th><th>Player</th><th>SH</th><th>SOG</th><th>G</th><th>A</th></tr></thead>
            <tbody>
                <tr><td>gk</td><td>1</td><td>Keeper, Sam</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
                <tr><td>f</td><td>9</td><td>Scorer, Alex</td><td>4</td><td>2</td><td>1</td><td>1</td></tr>
                <tr><td></td><td></td><td>Totals</td><td>4</td><td>2</td><td>1</td><td>1</td></tr>
            </tbody>
        </table>`;

    const parsed = new SidearmBoxScoreParser().parse(html, { sourceUrl: 'https://example.com/boxscore/1' });
    assert.equal(parsed.playerStats.length, 2, 'two players, and the Totals row is not one');

    const scorer = parsed.playerStats.find(p => p.player_name.includes('Scorer'))!;
    assert.equal(scorer.team_id, 'W&M', 'the squad comes from the caption');
    assert.equal(scorer.goals, 1);
    assert.equal(scorer.assists, 1);
    assert.equal(scorer.shots, 4);
    assert.equal(scorer.stats?.shots_on_goal, 2);
    // Absent, not zero — a missing column says nothing about how long anyone played, and
    // recording 0 would put every one of these players on the bench.
    assert.equal(scorer.minutes, null);
});

test('columns are read by their header, not by their position', () => {
    // The same statistics in a different order, which a fixed-offset reader gets wrong
    // without ever failing.
    const html = `
        <table>
            <caption>Elon - Player Stats</caption>
            <thead><tr><th>#</th><th>Player</th><th>MIN</th><th>G</th><th>A</th><th>SH</th><th>SOG</th></tr></thead>
            <tbody><tr><td>7</td><td>Winger, Jo</td><td>88</td><td>2</td><td>0</td><td>5</td><td>3</td></tr></tbody>
        </table>`;

    const [player] = new SidearmBoxScoreParser().parse(html, { sourceUrl: 'https://example.com/boxscore/2' })
        .playerStats;
    assert.equal(player.player_name, 'Winger, Jo');
    assert.equal(player.minutes, 88);
    assert.equal(player.goals, 2);
    assert.equal(player.assists, 0);
    assert.equal(player.shots, 5);
    assert.equal(player.stats?.shots_on_goal, 3);
});
