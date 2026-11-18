import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { looksLikeSummaryTable, parseSummaryTable } from '../src/summaryImport.js';
import { readXlsx, rowsToCsv, rowsToText } from '../src/xlsx.js';

/** A minimal zip writer: enough to hand-build .xlsx files (CRC left 0 — the reader doesn't check it). */
function zip(files, { store = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = store ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(store ? 0 : 8, 10);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const book = (sheets, { date1904 = false, styles, shared } = {}) => zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS}>${date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  ...(shared ? { 'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${NS}>${shared}</sst>` } : {}),
  ...(styles ? { 'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${NS}>${styles}</styleSheet>` } : {}),
  ...Object.fromEntries(sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0"?><worksheet ${NS}><sheetData>${s.xml}</sheetData></worksheet>`])),
});

// Style 0 general, 1 built-in date (14), 2 custom m/d/yyyy, 3 built-in time h:mm (20), 4 custom "Day "d-mmm, 5 [h]:mm elapsed.
const STYLES = '<numFmts count="3"><numFmt numFmtId="164" formatCode="m/d/yyyy"/><numFmt numFmtId="165" formatCode="&quot;Day &quot;d-mmm"/><numFmt numFmtId="166" formatCode="[h]:mm"/></numFmts>'
  + '<cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"/><xf numFmtId="20"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs>';

describe('reading .xlsx files with no library', () => {
  it('reads shared, rich-text, inline, formula and boolean cells, and keeps empty cells in place', async () => {
    const shared = '<si><t>date</t></si><si><r><t>main</t></r><r><rPr><b/></rPr><t xml:space="preserve">_task</t></r><rPh><t>X</t></rPh></si><si><t>Trench &amp; drain</t></si>';
    const xml = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>note</t></is></c></row>'
      + '<row r="2"><c r="A2" t="str"><f>A1</f><v>calc</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="e"><v>#N/A</v></c></row>'
      + '<row r="3"/>';
    const [sheet] = await readXlsx(book([{ name: 'S', xml }], { shared }));
    assert.deepEqual(sheet.rows, [['date', 'main_task', '', 'note'], ['calc', 'Trench & drain', 'TRUE', '#N/A']]);
  });

  it('turns date and time serials into YYYY-MM-DD and HH:MM by their number format', async () => {
    const xml = '<row r="1"><c r="A1" s="1"><v>46316</v></c><c r="B1" s="2"><v>46316</v></c><c r="C1" s="3"><v>0.5375</v></c><c r="D1" s="4"><v>46316</v></c><c r="E1"><v>57.600000000000001</v></c><c r="F1" s="5"><v>1.5</v></c><c r="G1"><v>1436</v></c></row>';
    const [sheet] = await readXlsx(book([{ name: 'S', xml }], { styles: STYLES }));
    assert.deepEqual(sheet.rows[0], ['2026-10-21', '2026-10-21', '12:54', '2026-10-21', '57.6', '1.5', '1436']);
  });

  it('honours the 1904 date system', async () => {
    const xml = '<row r="1"><c r="A1" s="1"><v>44854</v></c></row>';
    const [sheet] = await readXlsx(book([{ name: 'S', xml }], { styles: STYLES, date1904: true }));
    assert.deepEqual(sheet.rows[0], ['2026-10-21']);
  });

  it('reads stored (uncompressed) entries and every sheet in order', async () => {
    const buf = zip({
      'xl/workbook.xml': `<workbook ${NS}><sheets><sheet name="One" sheetId="1" r:id="a"/><sheet name="Two" sheetId="2" r:id="b"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="a" Target="/xl/worksheets/one.xml"/><Relationship Id="b" Target="worksheets/two.xml"/></Relationships>',
      'xl/worksheets/one.xml': '<worksheet><sheetData><row><c><v>1</v></c><c><v>2</v></c></row></sheetData></worksheet>',
      'xl/worksheets/two.xml': '<worksheet><sheetData><row><c t="inlineStr"><is><t>b</t></is></c></row></sheetData></worksheet>',
    }, { store: true });
    const sheets = await readXlsx(buf);
    assert.deepEqual(sheets, [{ name: 'One', rows: [['1', '2']] }, { name: 'Two', rows: [['b']] }]);
  });

  it('refuses a file that is not a zip, with a message saying what to do', async () => {
    await assert.rejects(readXlsx(Buffer.from('D0CF11E0 old binary xls')), /save it as \.xlsx or \.csv/);
  });

  it('writes rows back out as CSV and as plain text', () => {
    assert.equal(rowsToCsv([['a', 'b, c', 'say "hi"'], ['1']]), 'a,"b, c","say ""hi"""\n1,,');
    assert.equal(rowsToText([['Oct 21', '2:30 PM - 2:59 PM', '73-103', '']]), 'Oct 21  2:30 PM - 2:59 PM  73-103');
  });
});

describe('a TDEE table saved from Excel', () => {
  // tests/fixtures/tdee-sample.xlsx: synthetic rows written by openpyxl (dates as
  // date cells, the rest-day column as booleans, numbers as numbers), the table
  // on the second sheet behind a notes sheet.
  const FIXTURE = new URL('./fixtures/tdee-sample.xlsx', import.meta.url);

  it('reads into the same day-by-day import a CSV goes through', async () => {
    const sheets = await readXlsx(fs.readFileSync(FIXTURE));
    assert.deepEqual(sheets.map((s) => s.name), ['Read me', 'TDEE']);
    const csv = rowsToCsv(sheets[1].rows);
    assert.equal(looksLikeSummaryTable(csv), true);
    assert.equal(looksLikeSummaryTable(rowsToCsv(sheets[0].rows)), false);
    const { days, skipped } = parseSummaryTable(csv, { filename: 'tdee-sample.xlsx' });
    assert.equal(skipped.length, 0);
    assert.deepEqual(days.map((d) => [d.date, d.kind]), [['2026-06-01', 'work'], ['2026-06-07', 'rest'], ['2026-07-09', 'unusable'], ['2026-10-07', 'work']]);
    const oct = days.at(-1).patch;
    assert.equal(oct.shiftStart, '08:16');
    assert.deepEqual(oct.nonLaborWindows, [{ start: '12:01', end: '13:09' }]);
    assert.equal(oct.weightKg, 57.6);
  });
});
