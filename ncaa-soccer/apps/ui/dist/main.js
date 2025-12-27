"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.App = exports.TeamCard = void 0;
const react_1 = __importDefault(require("react"));
const shared_1 = require("@ncaa/shared");
const TeamCard = ({ team }) => {
    return (react_1.default.createElement("div", null,
        react_1.default.createElement("h1", null, team.name_canonical),
        react_1.default.createElement("p", null,
            "ID: ",
            team.team_id),
        react_1.default.createElement("p", null,
            "Conference: ",
            team.conference)));
};
exports.TeamCard = TeamCard;
// Simple smoke test for type usage
const dummyTeam = {
    team_id: "SMU",
    name_canonical: "SMU",
    conference: "ACC",
    sport: "msoc",
    aliases: ["Southern Methodist"]
};
// Validate it validates
try {
    shared_1.TeamSchema.parse(dummyTeam);
    console.log("UI: TeamSchema validation passed");
}
catch (e) {
    console.error("UI: TeamSchema validation failed");
}
const App = () => {
    return react_1.default.createElement(exports.TeamCard, { team: dummyTeam });
};
exports.App = App;
//# sourceMappingURL=main.js.map