import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../lib/csv';

describe('csv', () => {
  it('escapa comillas, comas y saltos de línea', () => {
    expect(csvCell('Ana, "la" Pérez')).toBe('"Ana, ""la"" Pérez"');
    expect(csvCell('línea\nnueva')).toBe('"línea\nnueva"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(1500)).toBe('1500');
  });

  it('neutraliza inyección de fórmulas', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+57300')).toBe("'+57300");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });

  it('agrega BOM UTF-8 y usa CRLF', () => {
    const out = toCsv(['A', 'B'], [['á', 1]]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe('A,B\r\ná,1\r\n');
  });
});
