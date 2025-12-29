"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const htmlPath = path_1.default.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs_1.default.readFileSync(htmlPath, 'utf8');
const regex = /window\.__NUXT__\.([a-zA-Z0-9_$]+)\s*=/g;
let match;
while ((match = regex.exec(html)) !== null) {
    console.log(`Found assignment to window.__NUXT__.${match[1]} at index ${match.index}`);
    // Print a bit of what follows to see if it looks like data
    console.log(html.substring(match.index, match.index + 100));
}
//# sourceMappingURL=peek_nuxt_props.js.map