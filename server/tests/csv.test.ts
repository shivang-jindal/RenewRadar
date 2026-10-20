/**
 * CSV helpers (Part A / A4.6, Part E / E7).
 *
 * Formula-injection protection is the important one: a subscription named
 * `=HYPERLINK(...)` must reach a spreadsheet as inert text, never as code.
 */

import { describe, expect, it } from 'vitest';

import { escapeCsvCell, parseCsv, toCsv } from '@renewradar/shared';

describe('escapeCsvCell neutralises formula injection', () => {
  it('prefixes every formula-leading character with a single quote', () => {
    expect(escapeCsvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('-1')).toBe("'-1");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvCell('\tleading tab')).toBe(`'${'\t'}leading tab`);
    expect(escapeCsvCell('\rcarriage return')).toBe(`"'${'\r'}carriage return"`);
  });

  it('leaves ordinary text and numbers alone', () => {
    expect(escapeCsvCell('Figma Professional')).toBe('Figma Professional');
    expect(escapeCsvCell('12.00')).toBe('12.00');
    expect(escapeCsvCell(1200)).toBe('1200');
    expect(escapeCsvCell(false)).toBe('false');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
    expect(escapeCsvCell('')).toBe('');
  });

  it('only quotes when the value actually needs it', () => {
    expect(escapeCsvCell('Design, Inc')).toBe('"Design, Inc"');
    expect(escapeCsvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(escapeCsvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(escapeCsvCell('No specials here')).toBe('No specials here');
  });

  it('escapes before quoting, so a quoted formula is still neutralised', () => {
    const value = escapeCsvCell('=1+1,"x"');
    expect(value.startsWith('"\'')).toBe(true);
    expect(value.endsWith('"')).toBe(true);
    expect(value).toContain('""x""');
  });

  it('serialises nested values as JSON rather than "[object Object]"', () => {
    expect(escapeCsvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('toCsv produces a spreadsheet-safe file', () => {
  it('writes a BOM, CRLF line endings and an escaped header', () => {
    const csv = toCsv([['Figma', '12.00']], ['name', 'amount']);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('name,amount\r\n');
    expect(csv).toContain('Figma,12.00\r\n');
  });

  it('round-trips through the parser with the escaping intact', () => {
    const rows = [['=cmd|calc', 'a,b', 'say "hi"']];
    const { header, rows: parsed } = parseCsv(toCsv(rows, ['name', 'vendor', 'notes']));
    expect(header).toEqual(['name', 'vendor', 'notes']);
    expect(parsed).toEqual([["'=cmd|calc", 'a,b', 'say "hi"']]);
  });
});

describe('parseCsv handles real-world files', () => {
  it('strips the BOM written by toCsv', () => {
    expect(parseCsv('\uFEFFname,vendor\nFigma,Figma Inc').header).toEqual(['name', 'vendor']);
  });

  it('handles quoted fields, escaped quotes, CRLF and embedded newlines', () => {
    const csv = 'name,notes\r\nFigma,"first line\r\nsecond line"\r\nGitHub,"say ""hi"""\r\n';
    const { header, rows } = parseCsv(csv);
    expect(header).toEqual(['name', 'notes']);
    expect(rows).toEqual([
      ['Figma', 'first line\nsecond line'],
      ['GitHub', 'say "hi"'],
    ]);
  });

  it('tolerates ragged rows and trailing newlines', () => {
    const { rows } = parseCsv('name,vendor,amount\r\nFigma,Figma Inc\r\n');
    expect(rows).toEqual([['Figma', 'Figma Inc']]);
  });

  it('returns an empty result for an empty file', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [] });
  });

  it('does not execute or interpret anything it reads', () => {
    const { rows } = parseCsv('name\n=1+1');
    expect(rows[0]![0]).toBe('=1+1');
  });
});