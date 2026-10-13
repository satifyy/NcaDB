/**
 * Reading a CSV, in the two sizes this dataset comes in.
 *
 * Every reader in the repository was `parse(fs.readFileSync(path, 'utf8'))`. For the
 * inventories and the season schedules that is fine. For the box scores it is not: a
 * season of `player_stats.csv` is 9-10 MB and 80,000-130,000 rows, and that call holds
 * the whole file as a string *and* the whole file again as an array of objects before the
 * caller sees the first row — while `build_ratings` walks eleven of them.
 *
 * So there are two functions. {@link readAll} is the old behaviour, named honestly.
 * {@link streamRows} yields one row at a time off a read stream, so the file never fully
 * lands; callers that only fold rows into a Map or a Set — which is most of them — can
 * switch to it without changing what they compute.
 */

import * as fs from 'fs';
import { parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';
import { CsvRow } from './rows';

export interface ReadOptions {
    /**
     * Tolerate rows with more or fewer fields than the header.
     *
     * Off by default, because a row that does not fit its header is normally a parser bug
     * worth hearing about. The box-score fetcher turns it on: it reads a `games.csv` that
     * may have been written by an older column set, and refusing to start is worse than
     * reading what is there.
     */
    relaxColumnCount?: boolean;
}

const options = (opts: ReadOptions = {}) => ({
    columns: true as const,
    skip_empty_lines: true,
    relax_column_count: opts.relaxColumnCount ?? false
});

/**
 * Every row of a file, in memory at once.
 *
 * For the small files — schedules, inventories, aggregated totals — and for the two
 * callers that rewrite a file in place and therefore need every row before they can write
 * the first.
 */
export function readAll<T extends CsvRow = CsvRow>(file: string, opts?: ReadOptions): T[] {
    return parseSync<T>(fs.readFileSync(file, 'utf8'), options(opts));
}

/**
 * Every row of a file, or none when the file is not there.
 *
 * A missing season is the normal case in a dataset that is backfilled a year at a time,
 * and every caller had its own `existsSync` guard in front of the read.
 */
export function readAllIfExists<T extends CsvRow = CsvRow>(file: string, opts?: ReadOptions): T[] {
    if (!fs.existsSync(file)) return [];
    return readAll<T>(file, opts);
}

/**
 * Every row of a file, one at a time, without holding the file.
 *
 * The parser is a transform stream and back-pressures against the reader, so memory stays
 * flat at roughly one row plus a buffer however large the file is. For a 9 MB season this
 * is the difference between a ~300 MB peak and a few megabytes.
 */
export async function* streamRows<T extends CsvRow = CsvRow>(
    file: string,
    opts?: ReadOptions
): AsyncGenerator<T> {
    const parser = fs.createReadStream(file).pipe(parse(options(opts)));
    for await (const record of parser) {
        yield record as T;
    }
}

/** As {@link streamRows}, yielding nothing when the file is not there. */
export async function* streamRowsIfExists<T extends CsvRow = CsvRow>(
    file: string,
    opts?: ReadOptions
): AsyncGenerator<T> {
    if (!fs.existsSync(file)) return;
    yield* streamRows<T>(file, opts);
}
