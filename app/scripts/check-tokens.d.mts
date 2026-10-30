export interface Violation {
  /** 相对扫描根目录的正斜杠路径。 */
  file: string;
  /** 从 1 计的行号。 */
  line: number;
  rule: string;
  snippet: string;
}

export const RULES: Record<string, string>;

export function checkTokens(options: { root: string }): Violation[];
