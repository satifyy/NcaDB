"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeTeamName = normalizeTeamName;
exports.normalizePlayerName = normalizePlayerName;
function normalizeTeamName(raw) {
    // strip rankings like "No. 7", trim, collapse whitespace
    return raw
        .replace(/^No\.\s*\d+\s+/i, "") // Remove starting "No. 7 "
        .trim()
        .replace(/\s+/g, " "); // Collapse whitespace
}
function normalizePlayerName(raw) {
    return raw.trim().replace(/\s+/g, " ");
}
//# sourceMappingURL=normalize.js.map