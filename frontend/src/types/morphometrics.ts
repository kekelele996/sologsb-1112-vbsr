/** 量度项目键 */
export type MeasureKey =
  | 'billLength'
  | 'billWidth'
  | 'wingLength'
  | 'tailLength'
  | 'tarsusLength'
  | 'weight';

/** 量度测量记录 */
export interface Morphometrics {
  id: string;
  /** 关联环志记录 */
  ringId: string;
  /** 喙长（mm）—— 现场原始数值（环志组录入，复核定论后锁定） */
  billLength: number;
  /** 喙宽（mm）—— 现场原始数值 */
  billWidth: number;
  /** 翅长（自然弦长，mm）—— 现场原始数值 */
  wingLength: number;
  /** 尾长（mm）—— 现场原始数值 */
  tailLength: number;
  /** 跗跖长（mm）—— 现场原始数值 */
  tarsusLength: number;
  /** 体重（g）—— 现场原始数值 */
  weight: number;
  /** 肥满度 0~4 —— 现场原始数值 */
  fatScore: number;
  /** 测量人 —— 现场信息 */
  measuredBy: string;
  /** 测量时间 ISO —— 现场信息 */
  measuredAt: string;
  /** 复核信息（资料室侧：结论 / 存疑 / 复测要求 / 修正值） */
  review: ReviewInfo;
}

/** 复核状态（资料室侧结论） */
export type ReviewStatus = 'pending' | 'confirmed' | 'doubtful' | 'remeasure';

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: '未复核',
  confirmed: '已定论',
  doubtful: '存疑',
  remeasure: '待复测',
};

export const REVIEW_STATUS_TAG_TYPE: Record<ReviewStatus, 'info' | 'success' | 'warning' | 'danger'> = {
  pending: 'info',
  confirmed: 'success',
  doubtful: 'warning',
  remeasure: 'danger',
};

/** 复核信息（资料室侧）：现场数值照原样保留，结论与更正另存 */
export interface ReviewInfo {
  status: ReviewStatus;
  /** 复核人 */
  reviewer?: string;
  /** 复核时间 ISO */
  reviewedAt?: string;
  /** 存疑说明（存疑时必填） */
  doubtNote?: string;
  /** 复测要求（待复测时必填） */
  remeasureRequest?: string;
  /** 修正值（仅更正的字段，另存不覆盖现场原始数值） */
  corrections?: Partial<Record<MeasureKey, number>>;
  /** 复核备注 */
  note?: string;
  /** 最近一次均线核定时间；核定后未定论记录据此重新比对，已定论记录不动 */
  recompareAt?: string;
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

/** 单字段偏离结果 */
export interface MeasureDeviation {
  key: MeasureKey;
  label: string;
  value: number;
  /** 同鸟种历史均值（无历史时为 0） */
  mean: number;
  /** 偏离百分比 */
  deviationPct: number;
  level: '正常' | '偏离' | '超出常见区间';
  message: string;
}

/** 现场量度字段（环志组录入，复核定论后锁定不可改） */
export const FIELD_MEASURE_KEYS: MeasureKey[] = ['billLength', 'billWidth', 'wingLength', 'tailLength', 'tarsusLength', 'weight'];

/** 取现场原始数值（环志组录入值，不受复核修正影响） */
export function fieldValuesOf(morph: Morphometrics): Record<MeasureKey, number> {
  return FIELD_MEASURE_KEYS.reduce(
    (acc, key) => {
      acc[key] = Number(morph[key]) || 0;
      return acc;
    },
    {} as Record<MeasureKey, number>,
  );
}

/** 取定论采用值：有修正值的字段取修正值，其余取现场原始数值 */
export function officialValuesOf(morph: Morphometrics): Record<MeasureKey, number> {
  const values = fieldValuesOf(morph);
  const corrections = morph.review?.corrections;
  if (corrections) {
    FIELD_MEASURE_KEYS.forEach((key) => {
      const corrected = corrections[key];
      if (corrected != null && Number(corrected) > 0) {
        values[key] = Number(corrected) || 0;
      }
    });
  }
  return values;
}

/** 是否存在更正（修正值与现场原值不一致） */
export function hasCorrections(morph: Morphometrics): boolean {
  const corrections = morph.review?.corrections;
  if (!corrections) return false;
  return FIELD_MEASURE_KEYS.some((key) => corrections[key] != null && Number(corrections[key]) > 0);
}

/** 是否已经定论（已定论：结论与原始数值都不动） */
export function isConcluded(morph: Morphometrics): boolean {
  return morph.review?.status === 'confirmed';
}

/** 是否进入复核（未定论但已有结论：现场原始数值锁定，改值只能走修正值） */
export function isLocked(morph: Morphometrics): boolean {
  return !!morph.review && morph.review.status !== 'pending';
}

/** 修正值与现场原值的对照（对不上清单用） */
export interface CorrectionDiff {
  key: MeasureKey;
  label: string;
  unit: string;
  original: number;
  corrected: number;
}

export function correctionDiff(morph: Morphometrics): CorrectionDiff[] {
  const corrections = morph.review?.corrections;
  if (!corrections) return [];
  return FIELD_MEASURE_KEYS.filter((key) => corrections[key] != null && Number(corrections[key]) > 0).map((key) => {
    const field = MEASURE_FIELDS.find((item) => item.key === key)!;
    return {
      key,
      label: field.label,
      unit: field.unit,
      original: Number(morph[key]) || 0,
      corrected: Number(corrections[key]) || 0,
    };
  });
}
