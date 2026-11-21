# csv-reader-speed-20261121

A faster drop-in for make.fun's csv-reader 1.0.0, entered in
`csv-reader-speed-01-run-20261121` ("Read broken CSV files faster,
21 November 2026").

- `solve.js` — dependency-free ES module. `run({text, header})` returns
  exactly csv-reader 1.0.0's `{columns, rows, errors}` for every input:
  BOM drop, LF/CRLF records, empty lines are no record, stray CRs
  (`stray_cr`), quoted fields with doubled quotes, CRLF/lone CR inside
  quotes read as LF, `quote_junk` after a closing quote, unterminated
  quotes re-read as unquoted (`unterminated_quote`), no trimming or
  conversion, header/row padding (`short_row`) and cutting (`long_row`).
  It reads with indexOf-driven field scans instead of one character at a
  time; the per-character loop survives only for the rare broken paths.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json`. Turns V8 incremental
  marking off, like the house baseline's driver.

## Local verification

Against the kit's practice set (6 cases, ~11 MB of CSV):

- Scorer: `passed 1, cases_passed 6/6`.
- CPU time (fresh process per run, trimmed mean of 9 runs after 1 warm-up,
  this VM): ~0.93 s vs the house baseline's ~2.01 s (~2.2x faster).
- 3,571 extra edge-case tests (hand-written + differential fuzzing against
  the oracle) all identical to csv-reader 1.0.0.
