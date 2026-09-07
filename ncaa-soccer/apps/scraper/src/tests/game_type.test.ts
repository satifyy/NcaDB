/**
 * What a stored row has to say before it may be called something other than a fixture.
 *
 * The cases that matter here are the ones where the marker is no longer on the name. The
 * pipeline cleans the team-name columns and leaves the ids alone, so almost every
 * exhibition in the dataset is identifiable only from `game_id` or `dedupe_key`, and a
 * classifier that reads the names alone finds under a tenth of them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGameType } from '@ncaa/parsers';

test('reads the exhibition marker off the id after the name has been cleaned', () => {
    // Exactly the shape stored rows take: name column already stripped, id untouched.
    const rows = [
        {
            game_id: 'sidearm-2026-08-08-Syracuse-Marist-(Exhibition)',
            dedupe_key: '2026-08-08-Marist-Syracuse',
            home_team_name: 'Syracuse',
            away_team_name: 'Marist',
            date: '2026-08-08'
        },
        {
            game_id: 'sidearm-2026-08-15-Georgia-State-Clemson-(Exhib.)',
            dedupe_key: '2026-08-15-Clemson-Georgia-State',
            home_team_name: 'Georgia State',
            away_team_name: 'Clemson',
            date: '2026-08-15'
        },
        {
            game_id: 'sidearm-2026-08-14-Oral-Roberts-Northeastern-State-(EXHIBITION)',
            dedupe_key: '2026-08-14-Northeastern-State-Oral-Roberts',
            home_team_name: 'Oral Roberts',
            away_team_name: 'Northeastern State',
            date: '2026-08-14'
        }
    ];
    for (const row of rows) {
        const result = classifyGameType(row);
        assert.equal(result.type, 'exhibition', row.game_id);
        assert.equal(result.evidence, 'marker', row.game_id);
    }
});

test('the structured flag outranks the text, and is the only way some rows are knowable', () => {
    // WMT states it and writes nothing into the name, so text alone would miss this.
    const result = classifyGameType({
        game_id: 'wmt-2026-08-05-Stanford-Sonoma-State',
        home_team_name: 'Stanford',
        away_team_name: 'Sonoma State',
        date: '2026-08-05',
        is_exhibition: true
    });
    assert.equal(result.type, 'exhibition');
    assert.equal(result.evidence, 'flag');
});

test('an ordinary fixture is regular, and says so by default rather than by finding', () => {
    const result = classifyGameType({
        game_id: 'wmt-2026-08-30-Stanford-UC-Davis',
        dedupe_key: '2026-08-30-Stanford-UC-Davis',
        home_team_name: 'Stanford',
        away_team_name: 'UC Davis',
        date: '2026-08-30'
    });
    assert.equal(result.type, 'regular');
    assert.equal(result.evidence, 'default');
});

test('a named NCAA round is the tournament regardless of where it falls', () => {
    const result = classifyGameType({
        game_id: 'sidearm-2025-11-20-Hofstra-Syracuse---First-Round',
        home_team_name: 'Hofstra',
        away_team_name: 'Syracuse',
        date: '2025-11-20'
    });
    assert.equal(result.type, 'ncaa_tournament');
});

test('an unnamed round is split between the brackets by the calendar', () => {
    const conference = classifyGameType({
        game_id: 'sidearm-2025-11-09-Hofstra-Stony-Brook-(CAA-Semifinals)',
        home_team_name: 'Hofstra',
        away_team_name: 'Stony Brook',
        date: '2025-11-09'
    });
    assert.equal(conference.type, 'conference_tournament');
    assert.equal(conference.evidence, 'date');

    const ncaa = classifyGameType({
        game_id: 'sidearm-2025-12-12-Saint-Louis-(Semifinals)-NC-State',
        home_team_name: 'Saint Louis',
        away_team_name: 'NC State',
        date: '2025-12-12'
    });
    assert.equal(ncaa.type, 'ncaa_tournament');
    assert.equal(ncaa.evidence, 'date');
});

test('a preseason bracket is not the postseason, however it words its rounds', () => {
    // Kickoff classics play finals in the same words the postseason does. The date is
    // what separates them, and August is not November.
    const result = classifyGameType({
        game_id: 'sidearm-2025-08-29-Duke-Portland-(Championship)',
        home_team_name: 'Duke',
        away_team_name: 'Portland',
        date: '2025-08-29'
    });
    assert.equal(result.type, 'regular');
});

test('the exhibition marker wins over a round marker on the same row', () => {
    // A friendly inside a preseason bracket is labelled both ways, and being a friendly
    // is the fact that should change how much the game counts.
    const result = classifyGameType({
        game_id: 'sidearm-2025-11-08-Marshall-Charleston-(Exhibition)-(Semifinals)',
        home_team_name: 'Marshall',
        away_team_name: 'Charleston',
        date: '2025-11-08'
    });
    assert.equal(result.type, 'exhibition');
});

test('no school is mistaken for a round', () => {
    // Hyphens in ids become word breaks, which is what lets "NCAA-First-Round" match —
    // and would let a hyphenated school match too if the patterns were looser.
    for (const [home, away] of [
        ['Gardner-Webb', 'Presbyterian'],
        ['Cal Poly', 'CSUN'],
        ['Saint Francis', 'Central Connecticut'],
        ['Loyola Chicago', 'Milwaukee']
    ] as const) {
        const result = classifyGameType({
            game_id: `sidearm-2025-11-05-${home.replace(/\s+/g, '-')}-${away.replace(/\s+/g, '-')}`,
            home_team_name: home,
            away_team_name: away,
            date: '2025-11-05'
        });
        assert.equal(result.type, 'regular', `${home} vs ${away}`);
    }
});

test('a round marker with no date behind it claims nothing', () => {
    const result = classifyGameType({
        game_id: 'sidearm-Quarterfinals',
        home_team_name: 'Presbyterian',
        away_team_name: 'Radford'
    });
    assert.equal(result.type, 'regular');
    assert.equal(result.evidence, 'default');
});
