/**
 * Which link a fixture's box score is read from, and when a substitute page is refused
 * (issue #45).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abbreviates, assignBoxscoreLinks, contradictsScore } from '../utils/boxscore_links';
import type { LinkedGame } from '../utils/boxscore_links';

test('a link shared by several fixtures is nobody’s; each falls back to its own alternate, or is dropped', () => {
    const stale = 'https://hubison.com/boxscore.aspx?id=12419';
    const input: LinkedGame[] = [
        { game_id: 'howard-delaware', boxscore_url: stale, boxscore_url_alt: 'https://bluehens.com/boxscore/35330' },
        { game_id: 'howard-other', boxscore_url: stale, boxscore_url_alt: '' },
        // An alternate that another fixture also names is no better than the shared link.
        { game_id: 'howard-third', boxscore_url: stale, boxscore_url_alt: 'https://x.com/shared' },
        { game_id: 'elsewhere', boxscore_url: 'https://x.com/shared' },
        { game_id: 'plain', boxscore_url: 'https://gocrimson.com/boxscore/1' }
    ];
    const { games, rescued, dropped } = assignBoxscoreLinks(input);
    assert.deepEqual(rescued, ['howard-delaware']);
    assert.deepEqual(dropped.sort(), ['howard-other', 'howard-third']);
    const rescuedGame = games.find(g => g.game_id === 'howard-delaware')!;
    assert.deepEqual([rescuedGame.boxscore_url, rescuedGame.boxscore_url_alt, rescuedGame.via_alternate], ['https://bluehens.com/boxscore/35330', '', true]);
    assert.ok(games.find(g => g.game_id === 'plain') && !games.find(g => g.game_id === 'plain')!.via_alternate);
});

test('a substitute page that gives a side more goals than it scored is another game', () => {
    const sides = [{ name: 'Winthrop', score: 8 }, { name: 'Johnson & Wales (N.C.)', score: 0 }];
    // Winthrop's "other copy" of its 8-0 win is a 0-3 loss.
    assert.equal(contradictsScore([{ team_id: 'Johnson & Wales (N.C.)', goals: 3 }, { team_id: 'Winthrop', goals: 0 }], sides), true);
    // Fewer goals than the score (an own goal, an unattributed goal) is not a contradiction.
    assert.equal(contradictsScore([{ team_id: 'Winthrop', goals: 7 }, { team_id: 'Johnson & Wales (N.C.)', goals: 0 }], sides), false);
    // No final score, no judgment.
    assert.equal(contradictsScore([{ team_id: 'Winthrop', goals: 9 }], [{ name: 'Winthrop', score: null }]), false);
});

test('a short label that abbreviates a side is that side, even when it also names another school', () => {
    assert.equal(abbreviates('BC', 'Blackburn College'), true, 'Blackburn calls itself BC; so does Boston College');
    assert.equal(abbreviates('VIL', 'Villanova'), true);
    assert.equal(abbreviates('BC', 'Lindenwood'), false);
    assert.equal(abbreviates('Longwood', 'Georgetown'), false);
    assert.equal(abbreviates('Boston College', 'Blackburn College'), false, 'a full name is never an abbreviation');
});
