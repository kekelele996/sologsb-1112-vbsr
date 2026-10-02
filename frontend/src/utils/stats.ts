import type { MeasureBaseline, MeasureBaselineSet, MeasureDeviation, MeasureKey, MeasureValueSet, Morphometrics } from '../types/morphometrics';
import { MEASURE_FIELDS, quarterOf } from '../types/morphometrics';
import type { MeasureReview } from '../types/morphometrics';
import type { RingRecord, RingStatus } from '../types/ring-record';
import type { SessionStats, SurveySession } from '../types/session';

/** 常见环志鸟种目录（中文名 + 学名），供 SpeciesPicker 联想与自定义补充 */
export const SPECIES_CATALOG: Array<{ cn: string; sci: string }> = [
  { cn: '红喉歌鸲', sci: 'Calliope calliope' },
  { cn: '红胁蓝尾鸲', sci: 'Tarsiger cyanurus' },
  { cn: '北红尾鸲', sci: 'Phoenicurus auroreus' },
  { cn: '黄眉柳莺', sci: 'Phylloscopus inornatus' },
  { cn: '大山雀', sci: 'Parus cinereus' },
  { cn: '沼泽山雀', sci: 'Poecile palustris' },
  { cn: '震旦鸦雀', sci: 'Paradoxornis heudei' },
  { cn: '白眉鹀', sci: 'Emberiza tristrami' },
  { cn: '苇鹀', sci: 'Emberiza pallasi' },
  { cn: '灰喜鹊', sci: 'Cyanopica cyanus' },
  { cn: '黑腹滨鹬', sci: 'Calidris alpina' },
  { cn: '白腰杓鹬', sci: 'Numenius arquata' },
  { cn: '东方白鹳', sci: 'Ciconia boyciana' },
  { cn: '黄鹡鸰', sci: 'Motacilla tschutschensis' },
];

/** 各鸟种量度常见区间（mm / g），用于超出区间提示 */
export const SPECIES_MEASURE_RANGES: Record<string, Partial<Record<MeasureKey, [number, number]>>> = {
  红喉歌鸲: { billLength: [12, 16], wingLength: [68, 80], tailLength: [52, 66], tarsusLength: [21, 26], weight: [18, 28] },
  红胁蓝尾鸲: { billLength: [10, 14], wingLength: [68, 80], tailLength: [48, 60], tarsusLength: [19, 24], weight: [11, 19] },
  北红尾鸲: { billLength: [11, 15], wingLength: [72, 84], tailLength: [58, 70], tarsusLength: [20, 25], weight: [13, 21] },
  黄眉柳莺: { billLength: [8, 12], wingLength: [52, 64], tailLength: [34, 44], tarsusLength: [15, 19], weight: [5, 10] },
  大山雀: { billLength: [8, 12], wingLength: [66, 78], tailLength: [52, 64], tarsusLength: [17, 22], weight: [11, 19] },
  沼泽山雀: { billLength: [7, 11], wingLength: [58, 68], tailLength: [48, 60], tarsusLength: [15, 20], weight: [8, 14] },
  震旦鸦雀: { billLength: [8, 12], wingLength: [52, 64], tailLength: [72, 92], tarsusLength: [19, 25], weight: [13, 22] },
  白眉鹀: { billLength: [9, 13], wingLength: [70, 82], tailLength: [60, 72], tarsusLength: [17, 22], weight: [17, 27] },
  苇鹀: { billLength: [7, 11], wingLength: [60, 72], tailLength: [52, 64], tarsusLength: [16, 20], weight: [11, 19] },
  灰喜鹊: { billLength: [23, 32], wingLength: [126, 148], tailLength: [195, 235], tarsusLength: [28, 36], weight: [65, 100] },
  黑腹滨鹬: { billLength: [26, 38], wingLength: [100, 124], tailLength: [42, 58], tarsusLength: [24, 32], weight: [38, 75] },
  白腰杓鹬: { billLength: [105, 155], wingLength: [255, 305], tailLength: [95, 125], tarsusLength: [68, 88], weight: [560, 1050] },
  东方白鹳: { billLength: [195, 270], wingLength: [540, 620], tailLength: [200, 260], tarsusLength: [200, 260], weight: [2800, 4600] },
  黄鹡鸰: { billLength: [11, 16], wingLength: [72, 86], tailLength: [62, 78], tarsusLength: [20, 25], weight: [14, 24] },
};

export function speciesOf(ring: RingRecord): { cn: string; sci: string } {
  return { cn: ring.speciesCn, sci: ring.speciesSci };
}

/** 鸟种计数（按记录数降序） */
export function speciesCount(records: RingRecord[]): Array<{ speciesCn: string; speciesSci: string; count: number }> {
  const map = new Map<string, { speciesCn: string; speciesSci: string; count: number }>();
  records.forEach((record) => {
    const item = map.get(record.speciesCn) ?? { speciesCn: record.speciesCn, speciesSci: record.speciesSci, count: 0 };
    item.count += 1;
    map.set(record.speciesCn, item);
  });
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/** 状态分布 */
export function statusBreakdown(records: RingRecord[]): Record<RingStatus, number> {
  const result: Record<RingStatus, number> = { 初捕: 0, 重捕: 0, 回收: 0 };
  records.forEach((record) => {
    result[record.status] += 1;
  });
  return result;
}

/** 重捕率（%）：重捕 / (初捕 + 重捕) */
export function recaptureRate(records: RingRecord[]): number {
  const created = records.filter((r) => r.status === '初捕').length;
  const recaptured = records.filter((r) => r.status === '重捕').length;
  const base = created + recaptured;
  return base > 0 ? Number(((recaptured / base) * 100).toFixed(1)) : 0;
}

/** 批次统计：鸟种数、初捕数与重捕数 */
export function buildSessionStats(session: SurveySession, records: RingRecord[], siteName: string): SessionStats {
  const scoped = records.filter((record) => record.sessionId === session.id);
  const breakdown = statusBreakdown(scoped);
  const base = breakdown.初捕 + breakdown.重捕;
  return {
    session,
    siteName,
    speciesCount: new Set(scoped.map((record) => record.speciesCn)).size,
    firstCount: breakdown.初捕,
    recaptureCount: breakdown.重捕,
    recoveryCount: breakdown.回收,
    recaptureRate: base > 0 ? Number(((breakdown.重捕 / base) * 100).toFixed(1)) : 0,
  };
}

/**
 * 复核采用的量度数值：资料室已另存修正值的量度项用修正值，其余照原样用现场原始数值。
 * 现场原始数值始终保留在 morph 上，这里只是计算时取值。
 */
export function effectiveValuesOf(morph: Morphometrics, review?: MeasureReview): MeasureValueSet {
  const values = {} as MeasureValueSet;
  MEASURE_FIELDS.forEach((field) => {
    const corrected = review?.corrected?.[field.key];
    values[field.key] = typeof corrected === 'number' && corrected > 0 ? corrected : Number(morph[field.key]) || 0;
  });
  return values;
}

/** 单个量度项的均线（均值 + 样本标准差 + 样本量） */
function baselineOf(values: number[]): MeasureBaseline {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  const count = valid.length;
  if (count === 0) return { mean: 0, std: 0, count: 0 };
  const mean = valid.reduce((sum, v) => sum + v, 0) / count;
  // 样本标准差（n-1）；只有一个样本时离散度记 0
  const variance = count > 1 ? valid.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (count - 1) : 0;
  return { mean: Number(mean.toFixed(2)), std: Number(Math.sqrt(variance).toFixed(2)), count };
}

/**
 * 试算全部「鸟种 × 季度」的均线（均值 + 标准差）。
 * 未经核定前用于页面提示；资料室按季核定后以 SpeciesBaseline 为准。
 * 取值规则：已定论「已修正」的记录用修正值参与统计，其余用现场原始数值；
 * 「两边不符」等尚未确认的记录仍按原始数值参与（结论侧尚无定论）。
 */
export function provisionalBaselines(
  records: RingRecord[],
  morphs: Morphometrics[],
  reviews: MeasureReview[],
): Record<string, Record<string, MeasureBaselineSet>>;
/** 试算指定季度的均线（季度参数缺省返回全部季度）。 */
export function provisionalBaselines(
  records: RingRecord[],
  morphs: Morphometrics[],
  reviews: MeasureReview[],
  quarter: string,
): Record<string, MeasureBaselineSet>;
export function provisionalBaselines(
  records: RingRecord[],
  morphs: Morphometrics[],
  reviews: MeasureReview[],
  quarter?: string,
): Record<string, Record<string, MeasureBaselineSet>> | Record<string, MeasureBaselineSet> {
  const speciesByRing = new Map(records.map((record) => [record.id, record.speciesCn]));
  const reviewByMorph = new Map(reviews.map((review) => [review.morphId, review]));
  // 两层分桶：季度 → 鸟种 → 样本
  const buckets = new Map<string, Map<string, MeasureValueSet[]>>();

  morphs.forEach((morph) => {
    const species = speciesByRing.get(morph.ringId);
    if (!species) return;
    if (quarter && quarterOf(morph.measuredAt) !== quarter) return;
    const q = quarterOf(morph.measuredAt);
    const speciesBuckets = buckets.get(q) ?? new Map<string, MeasureValueSet[]>();
    const list = speciesBuckets.get(species) ?? [];
    list.push(effectiveValuesOf(morph, reviewByMorph.get(morph.id)));
    speciesBuckets.set(species, list);
    buckets.set(q, speciesBuckets);
  });

  const byQuarter: Record<string, Record<string, MeasureBaselineSet>> = {};
  buckets.forEach((speciesBuckets, q) => {
    const result: Record<string, MeasureBaselineSet> = {};
    speciesBuckets.forEach((list, species) => {
      const set = {} as MeasureBaselineSet;
      MEASURE_FIELDS.forEach((field) => {
        set[field.key] = baselineOf(list.map((values) => values[field.key]));
      });
      result[species] = set;
    });
    byQuarter[q] = result;
  });

  return quarter ? byQuarter[quarter] ?? {} : byQuarter;
}

/**
 * 资料室按季核定时建议的均线：按鸟种 + 季度从现有量度（修正值优先）试算。
 */
export function suggestBaseline(
  speciesCn: string,
  quarter: string,
  records: RingRecord[],
  morphs: Morphometrics[],
  reviews: MeasureReview[],
): MeasureBaselineSet {
  const speciesByRing = new Map(records.map((record) => [record.id, record.speciesCn]));
  const reviewByMorph = new Map(reviews.map((review) => [review.morphId, review]));
  const rows: MeasureValueSet[] = [];
  morphs.forEach((morph) => {
    if (speciesByRing.get(morph.ringId) !== speciesCn) return;
    if (quarterOf(morph.measuredAt) !== quarter) return;
    rows.push(effectiveValuesOf(morph, reviewByMorph.get(morph.id)));
  });
  const set = {} as MeasureBaselineSet;
  MEASURE_FIELDS.forEach((field) => {
    set[field.key] = baselineOf(rows.map((values) => values[field.key]));
  });
  return set;
}

/**
 * 单条量度与同鸟种均线、常见区间的偏离计算。
 * 均线偏离（相对均值的百分比）与统计值（距离均值多少个标准差）两个都算。
 */
export function deviationsOf(
  values: Record<MeasureKey, number>,
  speciesCn: string,
  baseline?: MeasureBaselineSet,
  approved = false,
): MeasureDeviation[] {
  const ranges = SPECIES_MEASURE_RANGES[speciesCn] ?? {};
  return MEASURE_FIELDS.map((field) => {
    const value = Number(values[field.key]) || 0;
    const mean = baseline?.[field.key]?.mean ?? 0;
    const std = baseline?.[field.key]?.std ?? 0;
    const deviationPct = mean > 0 ? Number((((value - mean) / mean) * 100).toFixed(1)) : 0;
    // 统计偏离：z 值；标准差为 0（样本不足）时不计算
    const zScore = std > 0 ? Number(((value - mean) / std).toFixed(2)) : 0;
    const range = ranges[field.key];
    let level: MeasureDeviation['level'] = '正常';
    const source = approved ? '本季核定均线' : '试算均线';
    let message =
      mean > 0
        ? `与${source} ${mean}${field.unit} 偏离 ${deviationPct > 0 ? '+' : ''}${deviationPct}%，统计偏离 ${std > 0 ? `${zScore > 0 ? '+' : ''}${zScore}σ` : '样本不足'}`
        : '暂无同鸟种本季均线可比对';

    if (value < field.min || value > field.max) {
      level = '超出常见区间';
      message = `${field.label} ${value}${field.unit} 超出量度录入范围 ${field.min}~${field.max}${field.unit}`;
    } else if (range && (value < range[0] || value > range[1])) {
      level = '超出常见区间';
      message = `${field.label} ${value}${field.unit} 超出「${speciesCn}」常见区间 ${range[0]}~${range[1]}${field.unit}`;
    } else if (mean > 0 && std > 0 && Math.abs(zScore) >= 2) {
      level = '偏离';
      message = `${field.label} 与${source} ${mean}${field.unit} 统计偏离 ${zScore > 0 ? '+' : ''}${zScore}σ（均线偏离 ${deviationPct > 0 ? '+' : ''}${deviationPct}%）`;
    } else if (mean > 0 && Math.abs(deviationPct) > 15) {
      level = '偏离';
      message = `${field.label} 与${source} ${mean}${field.unit} 均线偏离 ${deviationPct > 0 ? '+' : ''}${deviationPct}%（统计偏离 ${std > 0 ? `${zScore > 0 ? '+' : ''}${zScore}σ` : '样本不足'}）`;
    }
    return { key: field.key, label: field.label, value, mean, std, deviationPct, zScore, approved, level, message };
  });
}

/** 是否存在需要提示的偏离项 */
export function hasWarning(deviations: MeasureDeviation[]): boolean {
  return deviations.some((item) => item.level !== '正常');
}
