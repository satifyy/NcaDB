"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registry = exports.ParserRegistry = exports.NotImplementedParser = void 0;
class NotImplementedParser {
    constructor() {
        this.name = 'not-implemented';
    }
    async parseSchedule(html, options) {
        return [];
    }
    async parseBoxScore(html, options) {
        return { game: {}, playerStats: [] };
    }
}
exports.NotImplementedParser = NotImplementedParser;
class ParserRegistry {
    constructor() {
        this.parserMap = new Map(); // school/team_id -> parserKey
        this.parsers = new Map();
        this.registerParser("default", new NotImplementedParser());
    }
    registerParser(key, parser) {
        this.parsers.set(key, parser);
    }
    mapTeamToParser(teamId, parserKey) {
        this.parserMap.set(teamId, parserKey);
    }
    getParser(teamId) {
        const parserKey = this.parserMap.get(teamId) || "default";
        return this.parsers.get(parserKey) || new NotImplementedParser();
    }
}
exports.ParserRegistry = ParserRegistry;
exports.registry = new ParserRegistry();
//# sourceMappingURL=registry.js.map