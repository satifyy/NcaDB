"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeGameDedupeKey = makeGameDedupeKey;
exports.makeGameId = makeGameId;
exports.makePlayerKey = makePlayerKey;
const normalize_1 = require("./normalize");
function makeGameDedupeKey(date, home_team_id, away_team_id) {
    // date:home:away normalized
    return `${date}:${home_team_id}:${away_team_id}`;
}
function makeGameId(dedupe_key) {
    // Simple base64 encoding of the key for ID-safety, or just use the key if valid chars
    // Requirement says "hash or stable encoding".
    // Let's use a simple buffer encoding for now to avoid long keys if they get complex,
    // but readable is often better. Let's stick to the key itself or a simple hash.
    // Using Buffer to base64
    return Buffer.from(dedupe_key).toString('base64').replace(/=/g, '');
}
function makePlayerKey(team_id, player_name) {
    return `${team_id}:${(0, normalize_1.normalizePlayerName)(player_name)}`;
}
//# sourceMappingURL=ids.js.map