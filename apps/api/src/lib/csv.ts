/**
 * CSV seguro para Excel/Sheets: escapa comillas y neutraliza "inyección de fórmulas"
 * (celdas que empiezan por = + - @ se prefijan con una comilla simple).
 */
const BOM = String.fromCharCode(0xfeff);

export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(','));
  // BOM para que Excel abra UTF-8 (tildes, ñ) correctamente.
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
