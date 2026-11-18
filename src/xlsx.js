/**
 * Excel (.xlsx) → rows of cell text, with no library.
 *
 * An .xlsx file is a zip of XML documents: the workbook lists the sheets,
 * each sheet holds its cells, text cells point into a shared-strings table,
 * and the styles say which numbers are dates. This reads just that much —
 * values as they'd be typed, not formulas or formatting — so a sheet can be
 * imported exactly like a CSV or a paste. Dates come out as YYYY-MM-DD and
 * times as HH:MM, whatever display format the sheet used.
 *
 * Decompression uses the browser's built-in DecompressionStream, so this
 * works offline. Old binary .xls files are a different format and are not read.
 */

const td = new TextDecoder('utf-8');

/* -------------------------------- zip -------------------------------- */

/** Central directory of a zip → { name: { method, size, offset } }. */
function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This isn’t an .xlsx file (no zip directory found). If it’s an old .xls, save it as .xlsx or .csv first.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = {};
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error('The .xlsx file’s zip directory is damaged.');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out[name.replace(/^\/+/, '')] = { method, size, offset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t unpack .xlsx files. Save the sheet as .csv instead.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(bytes, entries, name) {
  const e = entries[name];
  if (!e) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`The .xlsx file is damaged (${name}).`);
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
  const data = bytes.subarray(start, start + e.size);
  if (e.method === 0) return td.decode(data);
  if (e.method === 8) return td.decode(await inflateRaw(data));
  throw new Error(`The .xlsx file uses a compression this app can’t read (method ${e.method}).`);
}

/* -------------------------------- xml -------------------------------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) => {
  if (code[0] === '#') {
    const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isFinite(n) ? String.fromCodePoint(n) : all;
  }
  return ENTITIES[code] ?? all;
});

/** `a="1" r:id="rId2"` → { a: '1', 'r:id': 'rId2', id: 'rId2' } (a prefixed name is also kept bare). */
function attrs(text) {
  const out = {};
  for (const m of String(text).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const value = decode(m[2] ?? m[3]);
    out[m[1]] = value;
    const bare = m[1].split(':').pop();
    if (!(bare in out)) out[bare] = value;
  }
  return out;
}

/** All the text runs inside a string item (<t>…</t>), skipping phonetic guides. */
const textOf = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

/* ------------------------------ dates ------------------------------ */

const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56]);

/** 'date' | 'datetime' | 'time' | null for a number format. */
function dateKind(id, code) {
  if (BUILTIN_DATE.has(id)) return id === 22 ? 'datetime' : 'date';
  if (BUILTIN_TIME.has(id)) return 'time';
  if (!code) return null;
  // Drop quoted text, escapes and [colors]/[$-locale] before looking for date tokens.
  const f = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '').split(';')[0];
  if (/^\s*general\s*$/i.test(f) || /\[[hms]\]/i.test(f)) return null;
  const hasDate = /[dy]/i.test(f) || (/m/i.test(f) && !/[hs]/i.test(f));
  const hasTime = /[hs]/i.test(f) || /AM\/PM/i.test(f);
  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

function serialToText(serial, kind, date1904) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(serial * 86400) * 1000;
  const d = new Date(epoch + ms);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (kind === 'time' || (serial < 1 && kind !== 'date')) return time;
  if (kind === 'datetime' && Math.abs(serial % 1) > 1e-9) return `${day} ${time}`;
  return day;
}

/** 57.600000000000001 → "57.6"; whole numbers stay whole. */
function numberText(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

/* ------------------------------ workbook ------------------------------ */

const colIndex = (ref) => {
  const letters = String(ref).match(/^[A-Z]+/i);
  if (!letters) return null;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function sheetRows(xml, strings, styles, date1904) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const inner = rm[2] || '';
    const cells = [];
    let next = 0;
    for (const cm of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cm[1]);
      const body = cm[2] || '';
      const at = a.r ? colIndex(a.r) : next;
      next = (at ?? next) + 1;
      const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      const raw = v ? decode(v[1]) : '';
      let text = '';
      if (a.t === 's') text = strings[Number(raw)] ?? '';
      else if (a.t === 'inlineStr') text = textOf(body);
      else if (a.t === 'str' || a.t === 'e') text = raw;
      else if (a.t === 'b') text = raw === '1' ? 'TRUE' : 'FALSE';
      else if (a.t === 'd') text = raw.replace(/T00:00:00(\.0+)?Z?$/, '');
      else if (raw !== '') {
        const n = Number(raw);
        const kind = Number.isFinite(n) ? styles[Number(a.s) || 0] : null;
        text = !Number.isFinite(n) ? raw : kind ? serialToText(n, kind, date1904) : numberText(n);
      }
      cells[at ?? cells.length] = text;
    }
    const row = Array.from({ length: cells.length }, (_, i) => cells[i] ?? '');
    if (row.some((c) => String(c).trim() !== '')) rows.push(row);
  }
  return rows;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer the .xlsx file
 * @returns {Promise<{ name: string, rows: string[][] }[]>} every sheet, in workbook order
 */
export async function readXlsx(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const entries = zipEntries(bytes);
  const workbook = await readEntry(bytes, entries, 'xl/workbook.xml');
  if (!workbook) throw new Error('This zip isn’t an Excel workbook (no xl/workbook.xml).');
  const rels = (await readEntry(bytes, entries, 'xl/_rels/workbook.xml.rels')) || '';
  const target = {};
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) target[a.Id] = a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target}`.replace(/\/\.\//g, '/');
  }
  const sharedXml = (await readEntry(bytes, entries, 'xl/sharedStrings.xml')) || '';
  const strings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => textOf(m[1] || ''));
  const stylesXml = (await readEntry(bytes, entries, 'xl/styles.xml')) || '';
  const formats = {};
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    formats[Number(a.numFmtId)] = a.formatCode || '';
  }
  const xfs = (stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
  const styles = [...xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)].map((m) => {
    const id = Number(attrs(m[1]).numFmtId) || 0;
    return dateKind(id, formats[id]);
  });
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*"(?:1|true)"/i.test(workbook);

  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    const path = target[a['r:id'] || a.id];
    const xml = path ? await readEntry(bytes, entries, path) : null;
    if (xml) sheets.push({ name: a.name || `Sheet${sheets.length + 1}`, rows: sheetRows(xml, strings, styles, date1904) });
  }
  return sheets;
}

/** Rows → CSV text (quoted where needed), for the same importers a .csv file goes through. */
export function rowsToCsv(rows) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: width }, (_, i) => {
    const s = String(r[i] ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

/** Rows → plain text, one row per line with cells spaced apart (calendar text and heart-rate rows read this way). */
export const rowsToText = (rows) => rows.map((r) => r.filter((c) => String(c).trim() !== '').join('  ')).join('\n');
