/**
 * Writing a CSV.
 *
 * Thin on purpose — `csv-stringify` already does the work, and the only thing worth
 * centralising is the column decision, which is where rewriting a file in place goes
 * wrong. See {@link headerFrom}.
 */

import * as fs from 'fs';
import * as path from 'path';
import { stringify } from 'csv-stringify/sync';
import { CsvRow } from './rows';

/**
 * The columns to write, taken from the rows themselves rather than from a constant.
 *
 * A file with a column this codebase does not know about keeps it, and a column added by
 * a newer writer is appended rather than inserted — so a reader that indexes by position
 * finds every existing column exactly where it was.
 */
export function headerFrom(rows: CsvRow[], ensure: string[] = []): string[] {
    const seen: string[] = [];
    for (const row of rows) {
        for (const key of Object.keys(row)) {
            if (!seen.includes(key)) seen.push(key);
        }
    }
    for (const column of ensure) {
        if (!seen.includes(column)) seen.push(column);
    }
    return seen;
}

/** Writes rows to `file`, creating its directory if it is not there. */
export function writeRows(file: string, rows: object[], columns?: string[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stringify(rows, columns ? { header: true, columns } : { header: true }));
}
