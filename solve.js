// A faster drop-in for make.fun's csv-reader 1.0.0: readCsv's exact answers,
// read with indexOf-driven field scans instead of one character at a time.
//
// Semantics (csv-reader 1.0.0): the text is read once, left to right. A U+FEFF
// at its very start is dropped. A record ends at LF or CRLF, and a line left
// with no characters is no record. Outside quotes a CR not followed by LF is
// dropped (stray_cr). A field that opens with a quote runs to the next quote
// that is not doubled, "" inside it one quote and each CRLF or lone CR inside
// it read as LF; what follows its closing quote, up to the next comma or line
// break, is appended as it stands (quote_junk, when the field ends); a quote
// that never closes is a literal character, and the text after it is read
// again as unquoted (unterminated_quote). A quote inside an unquoted field is
// a literal character. Fields stay strings, never trimmed or converted.
// columns is the first record when header is true, else null; rows holds the
// records after it, each padded with "" (short_row, with fields: its field
// count) or cut (long_row, with extra: the cut fields) to the first record's
// width. Each error is {code, line, row}, in the order met, a record's
// short_row or long_row when it ends: line the 1-based line its record starts
// on, counting every LF, CRLF and lone CR inside quotes, and row its record's
// index in rows, null for the header.
//
// Speed notes: unquoted fields are taken as one slice up to the next comma or
// LF (two indexOf calls); quoted fields as one slice up to the closing quote,
// with doubled quotes and CR/LF folded only when present. The per-character
// loop survives only for the rare paths (a stray CR, junk after a closing
// quote, an unterminated quote), where correctness, not speed, rules.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** CRLF or a lone CR inside a quoted field each read as one LF. */
const CR_RE = /\r\n?/g;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Reads unquoted characters from `start`, onto `value`, up to the next comma
  // or line break. A CR not followed by LF is dropped (stray_cr). Returns the
  // field, how it ended, where reading stopped, and how many characters were
  // kept (the starting `value` itself is not counted). Slow path only: the
  // fast path below handles fields with no CR in them.
  function readUnquotedSlow(start, value) {
    let p = start;
    let added = 0;
    const parts = value === '' ? [] : [value];
    while (true) {
      let m = len;
      let kind = END;
      const c = text.indexOf(',', p);
      if (c !== -1 && c < m) {
        m = c;
        kind = COMMA;
      }
      const n = text.indexOf('\n', p);
      if (n !== -1 && n < m) {
        m = n;
        kind = LINE_BREAK;
      }
      const r = text.indexOf('\r', p);
      if (r !== -1 && r < m) {
        m = r;
        kind = 3; // a CR: stray, or the CRLF that ends the field
      }
      if (m > p) {
        parts.push(text.slice(p, m));
        added += m - p;
      }
      if (kind === COMMA) return { value: parts.join(''), added, ended: COMMA, next: m + 1 };
      if (kind === LINE_BREAK) {
        line += 1;
        return { value: parts.join(''), added, ended: LINE_BREAK, next: m + 1 };
      }
      if (kind === END) return { value: parts.join(''), added, ended: END, next: len };
      if (text.charCodeAt(m + 1) === 10) {
        line += 1;
        return { value: parts.join(''), added, ended: LINE_BREAK, next: m + 2 };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      p = m + 1;
    }
  }

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Declared here so the slow reader above sees
  // the current record's values when it is called.
  let recordLine = 1;
  let recordRow = null;

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = COMMA;
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        // A quoted field: run to the next quote that is not doubled.
        lastQuoted = true;
        const open = pos;
        let scan = pos + 1;
        let q = text.indexOf('"', scan);
        let doubled = false;
        while (q !== -1 && text.charCodeAt(q + 1) === 34) {
          doubled = true;
          scan = q + 2;
          q = text.indexOf('"', scan);
        }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const s = readUnquotedSlow(open + 1, '"');
          fields.push(s.value);
          pos = s.next;
          ended = s.ended;
          continue;
        }
        // The quoted span, and how many lines it spans: each CR counts once
        // (a CRLF through its CR), each LF not after a CR counts once.
        const raw = text.slice(open + 1, q);
        let nl = 0;
        let i = raw.indexOf('\r');
        while (i !== -1) {
          nl += 1;
          i = raw.indexOf('\r', i + 1);
        }
        i = raw.indexOf('\n');
        while (i !== -1) {
          if (raw.charCodeAt(i - 1) !== 13) nl += 1;
          i = raw.indexOf('\n', i + 1);
        }
        line += nl;
        let value;
        if (!doubled && nl === 0) {
          value = raw;
        } else if (!doubled) {
          value = raw.replace(CR_RE, '\n');
        } else if (nl === 0) {
          value = raw.replaceAll('""', '"');
        } else {
          value = raw.replaceAll('""', '"').replace(CR_RE, '\n');
        }
        pos = q + 1;
        if (pos >= len) {
          fields.push(value);
          ended = END;
          continue;
        }
        const c = text.charCodeAt(pos);
        if (c === 44) {
          fields.push(value);
          pos += 1;
          ended = COMMA;
        } else if (c === 10) {
          fields.push(value);
          pos += 1;
          line += 1;
          ended = LINE_BREAK;
        } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          fields.push(value);
          pos += 2;
          line += 1;
          ended = LINE_BREAK;
        } else {
          // What follows the closing quote is appended as it stands, up to
          // the next comma or line break.
          const s = readUnquotedSlow(pos, value);
          if (s.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          fields.push(s.value);
          pos = s.next;
          ended = s.ended;
        }
      } else {
        // An unquoted field: one slice up to the next comma or LF.
        lastQuoted = false;
        const c = text.indexOf(',', pos);
        const n = text.indexOf('\n', pos);
        let end;
        if (c === -1) {
          if (n === -1) {
            end = len;
            ended = END;
          } else {
            end = n;
            ended = LINE_BREAK;
          }
        } else if (n === -1) {
          end = c;
          ended = COMMA;
        } else if (c < n) {
          end = c;
          ended = COMMA;
        } else {
          end = n;
          ended = LINE_BREAK;
        }
        let value = text.slice(pos, end);
        const r = value.indexOf('\r');
        if (r !== -1) {
          if (r === value.length - 1 && ended === LINE_BREAK) {
            // The field ends in CRLF: the CR belongs to the line break.
            value = value.slice(0, -1);
            pos = end + 1;
            line += 1;
          } else {
            // A stray CR (or one mid-field): the slow reader drops it.
            const s = readUnquotedSlow(pos, '');
            value = s.value;
            pos = s.next;
            ended = s.ended;
          }
        } else if (ended === COMMA) {
          pos = end + 1;
        } else if (ended === LINE_BREAK) {
          pos = end + 1;
          line += 1;
        } else {
          pos = len;
        }
        fields.push(value);
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
