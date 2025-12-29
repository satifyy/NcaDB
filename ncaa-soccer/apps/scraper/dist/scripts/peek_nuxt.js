"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const htmlPath = path_1.default.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs_1.default.readFileSync(htmlPath, 'utf8');
const index = html.indexOf('window.__NUXT__');
if (index !== -1) {
    console.log(`Found window.__NUXT__ at index ${index}`);
    console.log('--- Context start ---');
    console.log(html.substring(index, index + 10000));
    console.log('--- Context end ---');
}
else {
    console.log('window.__NUXT__ NOT found');
}
//# sourceMappingURL=peek_nuxt.js.map