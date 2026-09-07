/**
 * Identity and naming rules the inventory depends on.
 *
 * These are the two failures that put the dataset in the state `normalize_inventory.ts`
 * had to repair: a school entering the inventory twice under two spellings, and a school
 * filed under a name none of its scraped rows carry. Both are silent — nothing throws,
 * the inventory simply describes a school the data does not have — so they are pinned
 * here rather than left to a scrape to reveal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SchoolIndex,
    pickCanonicalName,
    sameSchool,
    shortSchoolName,
    teamId
} from '../utils/school_names';

test('shortens formal institution names to their athletics form', () => {
    const cases: [string, string][] = [
        ['University of Denver', 'Denver'],
        ['Loyola Marymount University', 'Loyola Marymount'],
        ['University of the Pacific (United States)', 'Pacific'],
        ["Saint Mary's College of California", "Saint Mary's"],
        ['Clemson University', 'Clemson'],
        ['Michigan State University', 'Michigan State'],
        ['George Washington University', 'George Washington'],
        ['University of Portland', 'Portland']
    ];
    for (const [formal, short] of cases) assert.equal(shortSchoolName(formal), short, formal);
});

test('leaves a name alone when shortening it would name a different school', () => {
    // "Boston College" is the school's actual name; dropping "College" yields a school
    // that exists separately. The rule is only ever applied to "University".
    assert.equal(shortSchoolName('Boston College'), 'Boston College');
    assert.equal(shortSchoolName('College of Charleston'), 'College of Charleston');
    assert.equal(shortSchoolName('NC State'), 'NC State');
});

test('an established name outranks both the roster and the harvested spelling', () => {
    assert.equal(pickCanonicalName('Duke University', 'Blue Devils', 'Duke'), 'Duke');
    assert.equal(pickCanonicalName('California', 'Cal', 'California'), 'California');
});

test('a harvested athletics spelling outranks the roster name when it is terser', () => {
    assert.equal(pickCanonicalName('University of Pittsburgh', 'Pitt'), 'Pitt');
    assert.equal(pickCanonicalName('Duke University', 'Duke'), 'Duke');
    // ...but a mascot-decorated spelling never displaces the short roster form.
    assert.equal(pickCanonicalName('Clemson University', 'Clemson Tigers'), 'Clemson');
});

test('recognises long and short spellings of one school', () => {
    assert.ok(sameSchool('University of Michigan', 'Michigan'));
    assert.ok(sameSchool('University of the Pacific', 'Pacific'));
    assert.ok(sameSchool("St. John's (NY)", "St. John's"));
    assert.ok(sameSchool('Duke University', 'Duke'));
});

test('keeps schools apart that share a loose match key', () => {
    // Both answer to `boston`, and merging them cost Boston University its inventory
    // entry until identity became containment rather than a shared key.
    assert.ok(!sameSchool('Boston College', 'Boston University'));
    assert.ok(!sameSchool('Michigan', 'Michigan State'));
    assert.ok(!sameSchool('Northern Kentucky', 'Kentucky'));
});

test('SchoolIndex reports the existing entry instead of admitting a duplicate', () => {
    const index = new SchoolIndex<{ name_canonical: string; aliases?: string[] }>();

    assert.equal(index.add({ name_canonical: 'Duke' }), undefined);
    // The roster spelling of a school already present is a duplicate, not a new school.
    assert.deepEqual(index.add({ name_canonical: 'Duke University' }), { name_canonical: 'Duke' });
    assert.equal(index.size, 1);

    assert.equal(index.add({ name_canonical: 'Boston College' }), undefined);
    assert.equal(index.add({ name_canonical: 'Boston University' }), undefined);
    assert.equal(index.size, 3);
});

test('SchoolIndex finds a school by any spelling it answers to', () => {
    const index = new SchoolIndex<{ name_canonical: string; aliases?: string[] }>();
    index.add({ name_canonical: 'Pitt', aliases: ['Pittsburgh'] });

    assert.equal(index.find('University of Pittsburgh')?.name_canonical, 'Pitt');
    assert.equal(index.find('Pitt')?.name_canonical, 'Pitt');
    assert.equal(index.find('Penn State'), undefined);
});

test('team ids are stable slugs of the canonical name', () => {
    assert.equal(teamId('NC State'), 'NC_STATE');
    assert.equal(teamId("Saint Mary's"), 'SAINT_MARY_S');
    assert.equal(teamId('Boston University'), 'BOSTON_UNIVERSITY');
});


test('a name that fits two schools resolves to neither', () => {
    // `find` answers with the first match, which is what building an inventory wants.
    // Resolving a scraped name is the opposite problem: "Boston" is contained by both
    // Boston College and Boston University, and answering with whichever was added first
    // files one school's results under the other's name.
    const index = new SchoolIndex<{ name_canonical: string }>();
    index.add({ name_canonical: 'Boston College' });
    index.add({ name_canonical: 'Boston University' });
    index.add({ name_canonical: 'Clemson' });

    assert.equal(index.findUnique('Boston'), undefined);
    assert.equal(index.findUnique('Boston College')?.name_canonical, 'Boston College');
    assert.equal(index.findUnique('Boston University')?.name_canonical, 'Boston University');
    assert.equal(index.findUnique('Clemson University')?.name_canonical, 'Clemson');
});
