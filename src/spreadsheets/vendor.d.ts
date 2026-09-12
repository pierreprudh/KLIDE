declare module "fast-formula-parser" {
  export type Reference = { sheet?: string; row: number; col: number };
  export default class FormulaParser {
    static FormulaError: { new (code: string): Error; REF: Error; VALUE: Error; NAME: Error; NUM: Error };
    constructor(options: {
      onCell: (ref: Reference) => unknown;
      onRange: (ref: { sheet?: string; from: Reference; to: Reference }) => unknown[][];
    });
    parse(formula: string, position: Reference): unknown;
  }
}
