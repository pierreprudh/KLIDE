/** Kept free of engine imports: artifact routing runs at first paint. */
export function isSpreadsheetPath(path: string): boolean {
  return /(?:\.xlsx|\.sheet\.json)$/i.test(path);
}

export function isNativeWorkbook(path: string): boolean {
  return /\.sheet\.json$/i.test(path);
}
