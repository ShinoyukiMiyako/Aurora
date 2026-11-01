export interface PetalMark {
  palette: Record<string, string>;
  grid16: string[];
  grid12: string[];
}

export function renderMark(grid: string[], palette: Record<string, string>, size: number): Buffer;

export function buildIcons(mark: PetalMark): Record<string, Buffer>;
