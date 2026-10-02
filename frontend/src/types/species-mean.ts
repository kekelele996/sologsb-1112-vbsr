import type { MeasureKey } from './morphometrics';

/** 鸟种量度均线（资料室按季核定） */
export interface SpeciesMean {
  id: string;
  /** 鸟种中文名 */
  speciesCn: string;
  /** 季度标识，如 2026-Q3 */
  quarter: string;
  /** 核定的各量度均线（定论记录的定论采用值统计） */
  means: Record<MeasureKey, number>;
  /** 核定依据：定论记录数 */
  basedOn: number;
  /** 核定人（资料室） */
  approvedBy: string;
  /** 核定时间 ISO */
  approvedAt: string;
}

/** 当前季度标识，如 2026-Q4 */
export function currentQuarter(d = new Date()): string {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

/** 季度中文标签，如「2026 年第 3 季度」 */
export function quarterLabel(quarter: string): string {
  const [year, q] = quarter.split('-Q');
  return `${year} 年第 ${q} 季度`;
}
