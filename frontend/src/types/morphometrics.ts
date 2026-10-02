/** 量度项目键 */
export type MeasureKey =
  | 'billLength'
  | 'billWidth'
  | 'wingLength'
  | 'tailLength'
  | 'tarsusLength'
  | 'weight';

/** 六个量度项的数值集合 */
export type MeasureValueSet = Record<MeasureKey, number>;

/** 量度测量记录 —— 环志组现场原始数值，一经录入不得由资料室改动 */
export interface Morphometrics {
  id: string;
  /** 关联环志记录 */
  ringId: string;
  /** 喙长（mm） */
  billLength: number;
  /** 喙宽（mm） */
  billWidth: number;
  /** 翅长（自然弦长，mm） */
  wingLength: number;
  /** 尾长（mm） */
  tailLength: number;
  /** 跗跖长（mm） */
  tarsusLength: number;
  /** 体重（g） */
  weight: number;
  /** 肥满度 0~4 */
  fatScore: number;
  /** 测量人 */
  measuredBy: string;
  /** 测量时间 ISO */
  measuredAt: string;
}

/**
 * 资料室复核结论状态：
 * - 待复核：环志组刚录入，资料室尚未处理
 * - 维持原值：复核通过，原始数值照原样采用
 * - 存疑：资料室标注疑点，等待现场说明
 * - 复测：资料室要求环志组重新测量
 * - 已修正：资料室另存了修正值（原始数值仍保留）
 * - 两边不符：原始数值与修正值/资料室判断对不上，列出来等人确认
 */
export type ReviewStatus = '待复核' | '维持原值' | '存疑' | '复测' | '已修正' | '两边不符';

/** 「还没定论」的复核状态：均线核定后需重新比对 */
export const OPEN_REVIEW_STATUSES: ReviewStatus[] = ['待复核', '存疑', '复测', '两边不符'];

/** 「已定论」的复核状态：均线核定后结论与原始数值都不动 */
export const CLOSED_REVIEW_STATUSES: ReviewStatus[] = ['维持原值', '已修正'];

export function isOpenStatus(status: ReviewStatus): boolean {
  return OPEN_REVIEW_STATUSES.includes(status);
}

export function isClosedStatus(status: ReviewStatus): boolean {
  return CLOSED_REVIEW_STATUSES.includes(status);
}

/**
 * 资料室复核记录 —— 与现场量度记录（Morphometrics）一一对应、分侧存放。
 * 原始数值始终留在 morph 表，本侧只存结论、存疑/复测要求与「另存」的修正值。
 */
export interface MeasureReview {
  id: string;
  /** 关联现场量度记录 Morphometrics.id（唯一，一条现场量度对应一条复核） */
  morphId: string;
  /** 复核状态 */
  status: ReviewStatus;
  /**
   * 修正值（另存，不覆盖原始数值）。
   * 仅在资料室确认确需更正、且逐项给出修正数值时写入。
   */
  corrected?: Partial<MeasureValueSet>;
  /** 修正/复核说明 */
  note?: string;
  /** 存疑项（资料室标注、等待现场说明的量度项） */
  doubtKeys?: MeasureKey[];
  /** 复测项（资料室要求重新测量的量度项） */
  remeasureKeys?: MeasureKey[];
  /** 复核人 */
  reviewedBy: string;
  /** 复核时间 ISO */
  reviewedAt: string;
  /** 均线核定后对「未定论」记录重新比对的时间 ISO（定论记录不重比） */
  recomparedAt?: string;
  /**
   * 结论做出时所依据的均线快照（各量度项的均值/标准差）。
   * 定论后即使同鸟种均线被重新核定，本结论也不重算、不动。
   */
  baselineSnapshot?: MeasureBaselineSet;
}

/** 单个量度项的均线（均值 + 统计离散度） */
export interface MeasureBaseline {
  /** 均线：同鸟样本均值 */
  mean: number;
  /** 统计值：样本标准差 */
  std: number;
  /** 样本量 */
  count: number;
}

/** 六个量度项的均线集合 */
export type MeasureBaselineSet = Record<MeasureKey, MeasureBaseline>;

/**
 * 同鸟种均线核定单：由资料室按季核定。
 * 核定前页面显示的均线为「按原始数据实时试算」的未核定均线；
 * 核定后该鸟种当季以本单为准（结论快照），且尚未定论的复核重新比对。
 */
export interface SpeciesBaseline {
  id: string;
  /** 鸟种中文名 */
  speciesCn: string;
  /** 季度，形如 2024Q3 */
  quarter: string;
  /** 核定的均线集合 */
  values: MeasureBaselineSet;
  /** 核定人 */
  approvedBy: string;
  /** 核定时间 ISO */
  approvedAt: string;
  /** 备注（核定依据等） */
  note?: string;
}

/** 量度字段定义（单位与常见范围），供 MeasureInput 与偏离提示使用 */
export interface MeasureField {
  key: MeasureKey;
  label: string;
  unit: string;
  /** 通用常见范围 */
  min: number;
  max: number;
  step: number;
}

export const MEASURE_FIELDS: MeasureField[] = [
  { key: 'billLength', label: '喙长', unit: 'mm', min: 5, max: 320, step: 0.1 },
  { key: 'billWidth', label: '喙宽', unit: 'mm', min: 2, max: 40, step: 0.1 },
  { key: 'wingLength', label: '翅长', unit: 'mm', min: 40, max: 700, step: 0.5 },
  { key: 'tailLength', label: '尾长', unit: 'mm', min: 20, max: 400, step: 0.5 },
  { key: 'tarsusLength', label: '跗跖长', unit: 'mm', min: 8, max: 200, step: 0.1 },
  { key: 'weight', label: '体重', unit: 'g', min: 3, max: 6000, step: 0.1 },
];

/** 单字段偏离结果：均线偏离 + 统计（标准差）两个值都算 */
export interface MeasureDeviation {
  key: MeasureKey;
  label: string;
  value: number;
  /** 同鸟种均线均值（无均线时为 0） */
  mean: number;
  /** 同鸟种样本标准差（统计值，无样本时为 0） */
  std: number;
  /** 均线偏离百分比（相对均线均值） */
  deviationPct: number;
  /** 统计偏离：距离均线多少个标准差（z 值） */
  zScore: number;
  /** 均线是否已经资料室按季核定 */
  approved: boolean;
  level: '正常' | '偏离' | '超出常见区间';
  message: string;
}

/** 复核提交失败后进入发件箱的待重试条目（资料室侧） */
export interface ReviewOutboxItem {
  id: string;
  payload: string;
  createdAt: string;
  retriedAt?: string;
  lastError?: string;
}

/** 由 ISO 时间字符串取季度标识，如 2024-09-01 → 2024Q3 */
export function quarterOf(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${y}Q${q}`;
}
