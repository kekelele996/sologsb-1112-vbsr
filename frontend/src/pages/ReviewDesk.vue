<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import { useRingStore } from '../stores/ringStore';
import { useMeasureStore } from '../stores/measureStore';
import { useReviewStore, type ReviewInput } from '../stores/reviewStore';
import {
  MEASURE_FIELDS,
  isClosedStatus,
  quarterOf,
  type MeasureKey,
  type MeasureReview,
  type Morphometrics,
  type ReviewStatus,
} from '../types/morphometrics';
import { deviationsOf, effectiveValuesOf, suggestBaseline } from '../utils/stats';
import { formatDateTime } from '../utils/format';

const ringStore = useRingStore();
const measureStore = useMeasureStore();
const reviewStore = useReviewStore();

type TabKey = ReviewStatus | '全部' | '两边不符待确认';
const activeTab = ref<TabKey>('待复核');
const reviewer = ref('资料室·林岚');
const formRef = ref<FormInstance>();

const speciesOfRing = (ringId: string) => ringStore.rings.find((r) => r.id === ringId)?.speciesCn ?? '';
const ringOfMorph = (morph?: Morphometrics) => ringStore.rings.find((r) => r.id === morph?.ringId);

interface Row {
  morph: Morphometrics;
  review: MeasureReview;
  ringNo: string;
  species: string;
  quarter: string;
  measuredAt: string;
  /** 原始值与复核侧修正值对不上（等待人确认） */
  mismatches: MeasureKey[];
}

/** 现场原始值与资料室侧修正值逐项比对，列出两边对不上的量度项 */
function mismatchKeysOf(morph: Morphometrics, review?: MeasureReview): MeasureKey[] {
  if (!review?.corrected) return [];
  return MEASURE_FIELDS.filter((field) => {
    const corrected = review.corrected?.[field.key];
    return typeof corrected === 'number' && Number(corrected) > 0 && Number(corrected) !== Number(morph[field.key]);
  }).map((field) => field.key);
}

const rows = computed<Row[]>(() =>
  measureStore.morphs.map((morph) => {
    const review =
      reviewStore.reviewByMorph(morph.id) ??
      ({ id: `review-${morph.id}`, morphId: morph.id, status: '待复核' as const, reviewedBy: '', reviewedAt: '' } as MeasureReview);
    return {
      morph,
      review,
      ringNo: ringOfMorph(morph)?.ringNo ?? '未知环号',
      species: speciesOfRing(morph.ringId),
      quarter: quarterOf(morph.measuredAt),
      measuredAt: morph.measuredAt,
      mismatches: mismatchKeysOf(morph, review),
    };
  }),
);

/**
 * 「两边对不上」列表（等人确认）：
 * 资料室标了「两边不符」，或另存了与现场原始值不同的修正值但还没人工确认。
 * 一旦人工确认「维持原值 / 采纳修正值」定论后即移出列表。
 */
const mismatchRows = computed(() =>
  rows.value.filter(
    (row) => row.review.status === '两边不符' || (row.mismatches.length > 0 && !isClosedStatus(row.review.status)),
  ),
);

const tabs = computed(() => {
  const list: Array<{ key: TabKey; label: string; count: number }> = [
    { key: '全部', label: '全部', count: rows.value.length },
    ...(Object.keys(reviewStore.statusCounts) as ReviewStatus[]).map((status) => ({
      key: status as TabKey,
      label: status,
      count: reviewStore.statusCounts[status],
    })),
    { key: '两边不符待确认', label: '两边不符待确认', count: mismatchRows.value.length },
  ];
  return list;
});

const visibleRows = computed(() => {
  if (activeTab.value === '全部') return rows.value;
  if (activeTab.value === '两边不符待确认') return mismatchRows.value;
  return rows.value.filter((row) => row.review.status === activeTab.value);
});

/* ---------------- 复核结论编辑弹窗 ---------------- */

const dialogVisible = ref(false);
const editingMorph = ref<Morphometrics | null>(null);
const editingReview = ref<MeasureReview | null>(null);

const dialogStatus = ref<ReviewStatus>('待复核');
const note = ref('');
const doubtKeys = ref<MeasureKey[]>([]);
const remeasureKeys = ref<MeasureKey[]>([]);
const corrected = ref<Partial<Record<MeasureKey, number | undefined>>>({});

const dialogSpecies = computed(() => (editingMorph.value ? speciesOfRing(editingMorph.value.ringId) : ''));
const dialogQuarter = computed(() => (editingMorph.value ? quarterOf(editingMorph.value.measuredAt) : ''));
const approvedBaseline = computed(() =>
  dialogSpecies.value && dialogQuarter.value ? reviewStore.baselineOf(dialogSpecies.value, dialogQuarter.value) : undefined,
);
/** 复核当下所依据的均线：已定论记录用结论快照（核定后不重算）；
 * 未定论记录用已核定均线，尚无核定单则用当季全样本试算均线（明确标为未核定） */
const activeBaselineSet = computed(() => {
  const status = editingReview.value?.status ?? '待复核';
  if (isClosedStatus(status) && editingReview.value?.baselineSnapshot) {
    return editingReview.value.baselineSnapshot;
  }
  if (approvedBaseline.value) return approvedBaseline.value.values;
  return suggestBaseline(dialogSpecies.value, dialogQuarter.value, ringStore.rings, measureStore.morphs, reviewStore.reviews);
});

/** 现场原始值（照原样显示，只读） */
const rawValues = computed(() => {
  const morph = editingMorph.value;
  if (!morph) return {} as Record<MeasureKey, number>;
  return MEASURE_FIELDS.reduce((acc, field) => {
    acc[field.key] = Number(morph[field.key]) || 0;
    return acc;
  }, {} as Record<MeasureKey, number>);
});

/** 复核侧当前采用值：填了修正值用修正值，否则沿用原始值（不改原始值） */
const effectiveForDeviation = computed<Record<MeasureKey, number>>(() => {
  const acc = { ...rawValues.value } as Record<MeasureKey, number>;
  MEASURE_FIELDS.forEach((field) => {
    const c = corrected.value[field.key];
    if (typeof c === 'number' && c > 0) acc[field.key] = c;
  });
  return acc;
});

const deviations = computed(() =>
  deviationsOf(effectiveForDeviation.value, dialogSpecies.value, activeBaselineSet.value, !!approvedBaseline.value),
);

function openReview(row: Row) {
  editingMorph.value = row.morph;
  editingReview.value = row.review;
  dialogStatus.value = row.review.status === '待复核' ? '维持原值' : row.review.status;
  note.value = row.review.note ?? '';
  doubtKeys.value = [...(row.review.doubtKeys ?? [])];
  remeasureKeys.value = [...(row.review.remeasureKeys ?? [])];
  corrected.value = { ...(row.review.corrected ?? {}) };
  dialogVisible.value = true;
}

const correctionFieldList = computed(() =>
  MEASURE_FIELDS.map((field) => ({
    field,
    raw: rawValues.value[field.key],
    correction: corrected.value[field.key],
    filled: typeof corrected.value[field.key] === 'number' && (corrected.value[field.key] as number) > 0,
  })),
);

function enableCorrection(key: MeasureKey, checked: boolean) {
  if (checked) {
    corrected.value[key] = rawValues.value[key];
  } else {
    corrected.value[key] = undefined;
  }
}

async function submit() {
  const morph = editingMorph.value;
  if (!morph) return;
  if (!reviewer.value.trim()) {
    ElMessage.warning('请填写复核人');
    return;
  }
  if (dialogStatus.value === '复测' && remeasureKeys.value.length === 0) {
    ElMessage.warning('请勾选需要现场复测的量度项');
    return;
  }
  if (dialogStatus.value === '存疑' && doubtKeys.value.length === 0) {
    ElMessage.warning('请勾选存疑的量度项');
    return;
  }
  // 定论（维持原值/已修正）需要均线；均线尚未由资料室核定也可提交，但会明确提示依据的是试算均线
  const cleanCorrected: ReviewInput['corrected'] = {};
  MEASURE_FIELDS.forEach((field) => {
    const c = corrected.value[field.key];
    if (typeof c === 'number' && c > 0 && c !== rawValues.value[field.key]) {
      cleanCorrected![field.key] = c;
    }
  });
  if (dialogStatus.value === '已修正' && Object.keys(cleanCorrected ?? {}).length === 0) {
    ElMessage.warning('「已修正」需要勾选并填写与现场原始值不同的修正值；不更正请选「维持原值」');
    return;
  }
  const payload: ReviewInput = {
    morphId: morph.id,
    status: dialogStatus.value,
    corrected: dialogStatus.value === '已修正' && Object.keys(cleanCorrected ?? {}).length ? cleanCorrected : undefined,
    note: note.value,
    doubtKeys: dialogStatus.value === '存疑' ? doubtKeys.value : undefined,
    remeasureKeys: dialogStatus.value === '复测' ? remeasureKeys.value : undefined,
    reviewedBy: reviewer.value,
    baselineSnapshot: activeBaselineSet.value,
  };

  const result = await reviewStore.submitReview(payload);
  if (result.ok) {
    if (payload.corrected && Object.keys(payload.corrected).length) {
      ElMessage.success('已保存复核结论：现场原始数值保留不动，修正值另存在复核侧');
    } else {
      ElMessage.success('复核结论已提交，现场原始数值未改动');
    }
    dialogVisible.value = false;
  } else {
    ElMessageBox.alert(
      '复核结论写入本地存储失败，已转入「提交失败待重试」队列，稍后可在页面顶部一键重试，结论不会丢失。',
      '提交失败已暂存',
      { type: 'warning' },
    );
  }
}

/* ---------------- 两边不符确认 ---------------- */

async function confirmMismatch(row: Row, adopt: 'raw' | 'corrected') {
  const detail = row.mismatches
    .map((key) => {
      const field = MEASURE_FIELDS.find((f) => f.key === key)!;
      return `${field.label}：现场 ${row.morph[key]} / 修正 ${row.review.corrected?.[key]}`;
    })
    .join('；');
  const action = adopt === 'raw' ? '维持现场原始数值' : '采纳资料室修正值';
  const confirmed = await ElMessageBox.confirm(
    `以下量度项两边对不上：\n${detail}\n\n确认「${action}」并给这只鸟的复核定论？`,
    '两边不符 · 等人确认',
    { type: 'warning', confirmButtonText: `确认${action}`, cancelButtonText: '再看看' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await reviewStore.resolveMismatch(
    row.morph.id,
    adopt === 'raw' ? '维持原值' : '已修正',
    reviewer.value,
    `${row.review.note ?? ''}（两边不符经人工确认：${action}）`.trim(),
    adopt === 'corrected' ? row.review.corrected : undefined,
  );
  ElMessage.success('已按人工确认给复核定论，现场原始数值保留');
}

/** 列表行上计算该鸟种当季现行均线（核定优先，未核定用试算） */
function activeBaselineSetFor(row: Row) {
  const approved = reviewStore.baselineOf(row.species, row.quarter);
  if (approved) return approved.values;
  return suggestBaseline(row.species, row.quarter, ringStore.rings, measureStore.morphs, reviewStore.reviews);
}

/** 列表行：未定论记录相对现行均线是否仍有偏离项（均线核定重新比对后提示资料室关注） */
function openWarningsOf(row: Row): string[] {
  if (isClosedStatus(row.review.status)) return [];
  const deviations = deviationsOf(effectiveValuesOf(row.morph, row.review), row.species, activeBaselineSetFor(row));
  return deviations.filter((d) => d.level !== '正常').map((d) => d.message);
}

/* ---------------- 均线按季核定 ---------------- */

const baselineSpecies = ref('红喉歌鸲');
const baselineQuarter = ref(quarterOf(new Date().toISOString()));
const baselineApprover = ref('资料室·林岚');
const baselineNote = ref('');

const suggestedBaseline = computed(() =>
  suggestBaseline(baselineSpecies.value, baselineQuarter.value, ringStore.rings, measureStore.morphs, reviewStore.reviews),
);
const existingBaseline = computed(() => reviewStore.baselineOf(baselineSpecies.value, baselineQuarter.value));

const baselineTableRows = computed(() =>
  MEASURE_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    unit: field.unit,
    suggested: suggestedBaseline.value[field.key],
    approved: existingBaseline.value?.values[field.key],
  })),
);

async function approveBaseline() {
  // 该鸟种当季、尚未定论的现场量度，才在核定后重新比对；定论的不动
  const scopedOpenMorphIds = rows.value
    .filter((row) => row.species === baselineSpecies.value && row.quarter === baselineQuarter.value && !isClosedStatus(row.review.status))
    .map((row) => row.morph.id);
  const confirmed = await ElMessageBox.confirm(
    `核定「${baselineSpecies.value} · ${baselineQuarter.value}」均线后：该鸟种当季还没定论的 ${scopedOpenMorphIds.length} 条复核将按新均线重新比对；已定了论的结论和现场原始数值一律不动。确认核定？`,
    '按季核定均线',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  const { recompared } = await reviewStore.approveBaseline({
    speciesCn: baselineSpecies.value,
    quarter: baselineQuarter.value,
    values: suggestedBaseline.value,
    approvedBy: baselineApprover.value,
    note: baselineNote.value,
    recompareMorphIds: scopedOpenMorphIds,
  });
  ElMessage.success(`已核定${baselineQuarter.value}均线，${recompared} 条未定论复核已标记重新比对`);
}

/* ---------------- 提交失败重试 ---------------- */

async function retryOutbox() {
  const { succeeded, failed } = await reviewStore.retryOutbox();
  if (succeeded && !failed) ElMessage.success(`重试成功，${succeeded} 条复核结论已提交`);
  else if (succeeded && failed) ElMessage.warning(`${succeeded} 条重试成功，${failed} 条仍失败，保留在队列中`);
  else ElMessage.error('重试仍失败，请稍后再试（结论保留在队列中不会丢失）');
}

async function discardOutbox(id: string) {
  await reviewStore.discardOutbox(id);
  ElMessage.info('已移除该条待重试结论');
}

/* ---------------- 表格展示辅助 ---------------- */

const statusTagType: Record<ReviewStatus, 'info' | 'success' | 'warning' | 'danger' | 'primary'> = {
  待复核: 'info',
  维持原值: 'success',
  存疑: 'warning',
  复测: 'danger',
  已修正: 'primary',
  两边不符: 'danger',
};

function valueOf(row: Row, key: MeasureKey): { raw: number; shown: number; corrected: boolean } {
  const raw = Number(row.morph[key]) || 0;
  const c = row.review.corrected?.[key];
  if (typeof c === 'number' && c > 0) return { raw, shown: c, corrected: true };
  return { raw, shown: raw, corrected: false };
}

const isClosed = (status: ReviewStatus) => isClosedStatus(status);

const speciesOptions = computed(() =>
  Array.from(new Set(ringStore.rings.map((r) => r.speciesCn))).map((speciesCn) => ({ label: speciesCn, value: speciesCn })),
);
const quarterOptions = computed(() =>
  Array.from(new Set(measureStore.morphs.map((m) => quarterOf(m.measuredAt)))).sort().reverse(),
);
</script>

<template>
  <div>
    <h2 class="page-title">资料室复核台</h2>
    <p class="page-desc">
      复核侧只下结论，不改环志组现场原始数值；确需更正时另存修正值。均线偏离（%）与统计偏离（σ）两个值都算。
      同鸟种均线由资料室按季核定；核定后未定论的重新比对，已定了论的结论和原始数值都不动。
    </p>

    <!-- 提交失败重试 -->
    <el-alert
      v-if="reviewStore.pendingRetryCount > 0"
      type="error"
      show-icon
      :closable="false"
      class="outbox-alert"
    >
      <template #title>
        有 {{ reviewStore.pendingRetryCount }} 条复核结论提交失败，已暂存待重试（不会丢失）
      </template>
      <div class="outbox-actions">
        <el-button size="small" type="primary" @click="retryOutbox">一键重试全部</el-button>
        <el-button size="small" v-for="item in reviewStore.outbox" :key="item.id" @click="discardOutbox(item.id)">
          移除 {{ item.payload.status }}（{{ item.lastError || '写入失败' }}）
        </el-button>
      </div>
    </el-alert>

    <el-tabs v-model="activeTab" class="review-tabs">
      <el-tab-pane v-for="tab in tabs" :key="tab.key" :name="tab.key">
        <template #label>
          {{ tab.label }}
          <el-badge :value="tab.count" :hidden="tab.count === 0" :max="999" class="tab-badge" />
        </template>
      </el-tab-pane>
    </el-tabs>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <span>复核队列</span>
          <span class="card-note">带 <el-tag size="small" type="primary" effect="plain">修</el-tag> 的数值为资料室另存修正值，原始值在其后括号内</span>
        </div>
      </template>
      <EmptyPanel v-if="visibleRows.length === 0" description="该分类下暂无记录" />
      <el-table v-else :data="visibleRows" size="small" border>
        <el-table-column label="环号" width="100">
          <template #default="scope">{{ scope.row.ringNo }}</template>
        </el-table-column>
        <el-table-column label="鸟种 / 季度" width="120">
          <template #default="scope">
            <div>{{ scope.row.species }}</div>
            <div class="cell-sub">{{ scope.row.quarter }}</div>
          </template>
        </el-table-column>
        <el-table-column label="喙长" width="96">
          <template #default="scope">
            <span :class="{ 'is-corrected': valueOf(scope.row, 'billLength').corrected }">
              {{ valueOf(scope.row, 'billLength').shown }}
              <template v-if="valueOf(scope.row, 'billLength').corrected">({{ valueOf(scope.row, 'billLength').raw }})</template>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="喙宽" width="80">
          <template #default="scope">
            <span :class="{ 'is-corrected': valueOf(scope.row, 'billWidth').corrected }">
              {{ valueOf(scope.row, 'billWidth').shown }}
              <template v-if="valueOf(scope.row, 'billWidth').corrected">({{ valueOf(scope.row, 'billWidth').raw }})</template>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="翅长" width="80">
          <template #default="scope">
            <span :class="{ 'is-corrected': valueOf(scope.row, 'wingLength').corrected }">
              {{ valueOf(scope.row, 'wingLength').shown }}
              <template v-if="valueOf(scope.row, 'wingLength').corrected">({{ valueOf(scope.row, 'wingLength').raw }})</template>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="尾长" width="80">
          <template #default="scope">
            <span :class="{ 'is-corrected': valueOf(scope.row, 'tailLength').corrected }">
              {{ valueOf(scope.row, 'tailLength').shown }}
              <template v-if="valueOf(scope.row, 'tailLength').corrected">({{ valueOf(scope.row, 'tailLength').raw }})</template>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="跗跖" width="80">
          <template #default="scope">
            <span :class="{ 'is-corrected': valueOf(scope.row, 'tarsusLength').corrected }">
              {{ valueOf(scope.row, 'tarsusLength').shown }}
              <template v-if="valueOf(scope.row, 'tarsusLength').corrected">({{ valueOf(scope.row, 'tarsusLength').raw }})</template>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="体重" width="80">
          <template #default="scope">
            <span :class="{ 'is-corrected': valueOf(scope.row, 'weight').corrected }">
              {{ valueOf(scope.row, 'weight').shown }}
              <template v-if="valueOf(scope.row, 'weight').corrected">({{ valueOf(scope.row, 'weight').raw }})</template>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="复核结论" width="96">
          <template #default="scope">
            <el-tag :type="statusTagType[(scope.row as Row).review.status]" size="small">{{ (scope.row as Row).review.status }}</el-tag>
            <div v-if="(scope.row as Row).mismatches.length" class="cell-sub mismatch-text">
              {{ (scope.row as Row).mismatches.length }} 项两边不符
            </div>
          </template>
        </el-table-column>
        <el-table-column label="存疑 / 复测项" min-width="120">
          <template #default="scope">
            <el-tag v-for="k in (scope.row as Row).review.doubtKeys ?? []" :key="`d${k}`" type="warning" size="small" class="key-tag">
              {{ MEASURE_FIELDS.find((f) => f.key === k)?.label }}存疑
            </el-tag>
            <el-tag v-for="k in (scope.row as Row).review.remeasureKeys ?? []" :key="`r${k}`" type="danger" size="small" class="key-tag">
              {{ MEASURE_FIELDS.find((f) => f.key === k)?.label }}复测
            </el-tag>
            <span v-if="!((scope.row as Row).review.doubtKeys?.length || (scope.row as Row).review.remeasureKeys?.length)" class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="均线核定后重新比对" min-width="180">
          <template #default="scope">
            <template v-if="isClosed((scope.row as Row).review.status)">
              <span class="cell-sub">已定了论，结论与原始数值不动</span>
            </template>
            <template v-else-if="(scope.row as Row).review.recomparedAt">
              <el-tag v-for="msg in openWarningsOf(scope.row as Row)" :key="msg" type="warning" size="small" class="key-tag">{{ msg }}</el-tag>
              <el-tag v-if="openWarningsOf(scope.row as Row).length === 0" type="success" size="small">重比后无偏离</el-tag>
            </template>
            <span v-else class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="复核人 / 时间" width="160">
          <template #default="scope">
            <div v-if="scope.row.review.reviewedAt">
              {{ scope.row.review.reviewedBy }}
              <div class="cell-sub">{{ formatDateTime(scope.row.review.reviewedAt) }}</div>
              <div v-if="scope.row.review.recomparedAt && !isClosed(scope.row.review.status)" class="cell-sub recompare-text">
                均线核定后已重新比对
              </div>
            </div>
            <span v-else class="cell-sub">尚未复核</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="openReview(scope.row)">
              {{ isClosed(scope.row.review.status) ? '查看/改结论' : '复核' }}
            </el-button>
            <el-button
              v-if="(scope.row as Row).mismatches.length && (scope.row as Row).review.status !== '维持原值'"
              link
              type="success"
              @click="confirmMismatch(scope.row as Row, 'raw')"
            >维持原值</el-button>
            <el-button
              v-if="(scope.row as Row).mismatches.length && (scope.row as Row).review.status !== '维持原值'"
              link
              type="warning"
              @click="confirmMismatch(scope.row as Row, 'corrected')"
            >采纳修正值</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 按季核定均线 -->
    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">
          <span>同鸟种均线按季核定（资料室）</span>
          <span class="card-note">核定后：未定论的复核重新比对；已定了论的结论与现场原始数值不动</span>
        </div>
      </template>
      <div class="baseline-form">
        <el-select v-model="baselineSpecies" placeholder="鸟种" style="width: 160px">
          <el-option v-for="opt in speciesOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-select v-model="baselineQuarter" placeholder="季度" style="width: 130px">
          <el-option v-for="q in quarterOptions" :key="q" :label="q" :value="q" />
        </el-select>
        <el-input v-model="baselineApprover" style="width: 150px" placeholder="核定人" maxlength="16" />
        <el-input v-model="baselineNote" style="width: 240px" placeholder="核定依据（可选）" maxlength="60" />
        <el-button type="primary" @click="approveBaseline">核定 / 重新核定本季均线</el-button>
        <el-tag v-if="existingBaseline" type="success" size="small" effect="plain">
          已于 {{ formatDateTime(existingBaseline.approvedAt) }} 核定
        </el-tag>
      </div>
      <el-table :data="baselineTableRows" size="small" border class="baseline-table">
        <el-table-column label="量度项" prop="label" width="120" />
        <el-table-column label="单位" prop="unit" width="70" />
        <el-table-column label="试算均值（均线）" width="140">
          <template #default="scope">{{ scope.row.suggested.mean || '—' }}</template>
        </el-table-column>
        <el-table-column label="统计值（标准差 σ）" width="150">
          <template #default="scope">{{ scope.row.suggested.std || '—' }}（n={{ scope.row.suggested.count }}）</template>
        </el-table-column>
        <el-table-column label="当前核定均线" min-width="160">
          <template #default="scope">
            <template v-if="scope.row.approved">
              {{ scope.row.approved.mean }} ± {{ scope.row.approved.std }}（n={{ scope.row.approved.count }}）
            </template>
            <span v-else class="cell-sub">未核定</span>
          </template>
        </el-table-column>
      </el-table>
      <p class="card-note">试算口径：该鸟种当季现场量度；资料室已定论「已修正」的记录按修正值参与，其余按现场原始值。核定时以当前试算结果落单。</p>
    </el-card>

    <!-- 复核弹窗 -->
    <el-dialog v-model="dialogVisible" :title="`复核 · ${ringOfMorph(editingMorph ?? undefined)?.ringNo ?? ''} · ${dialogSpecies}`" width="860px">
      <div class="dialog-baseline">
        <el-tag size="small" :type="approvedBaseline ? 'success' : 'info'" effect="plain">
          {{ dialogQuarter }} 均线：{{ approvedBaseline ? '资料室已核定（本结论留快照，日后不再重算）' : '尚未核定，以下按试算均线比对' }}
        </el-tag>
      </div>

      <el-table :data="deviations" size="small" border class="dialog-table">
        <el-table-column label="量度项" width="90">
          <template #default="scope">{{ (scope.row as (typeof deviations)[number]).label }}</template>
        </el-table-column>
        <el-table-column label="现场原始值（只读）" width="130">
          <template #default="scope">
            <span class="raw-value">{{ rawValues[(scope.row as (typeof deviations)[number]).key] }} {{ (scope.row as (typeof deviations)[number]).key === 'weight' ? 'g' : 'mm' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="修正值（另存，留空=不改）" width="210">
          <template #default="scope">
            <el-checkbox
              :model-value="correctionFieldList.find((c) => c.field.key === (scope.row as (typeof deviations)[number]).key)?.filled"
              @update:model-value="(checked: boolean) => enableCorrection((scope.row as (typeof deviations)[number]).key, checked)"
            >更正此项</el-checkbox>
            <el-input-number
              v-if="correctionFieldList.find((c) => c.field.key === (scope.row as (typeof deviations)[number]).key)?.filled"
              :model-value="corrected[(scope.row as (typeof deviations)[number]).key]"
              :min="MEASURE_FIELDS.find((f) => f.key === (scope.row as (typeof deviations)[number]).key)?.min"
              :max="MEASURE_FIELDS.find((f) => f.key === (scope.row as (typeof deviations)[number]).key)?.max"
              :step="MEASURE_FIELDS.find((f) => f.key === (scope.row as (typeof deviations)[number]).key)?.step"
              :precision="1"
              size="small"
              @update:model-value="(v?: number) => (corrected[(scope.row as (typeof deviations)[number]).key] = typeof v === 'number' ? v : undefined)"
            />
          </template>
        </el-table-column>
        <el-table-column label="均线 / 统计" min-width="200">
          <template #default="scope">
            <div class="dev-line">均线 {{ (scope.row as (typeof deviations)[number]).mean || '—' }}，偏离 {{ (scope.row as (typeof deviations)[number]).mean ? `${(scope.row as (typeof deviations)[number]).deviationPct}%` : '—' }}</div>
            <div class="dev-line">σ {{ (scope.row as (typeof deviations)[number]).std || '—' }}，统计偏离 {{ (scope.row as (typeof deviations)[number]).std ? `${(scope.row as (typeof deviations)[number]).zScore}σ` : '样本不足' }}</div>
            <el-tag v-if="(scope.row as (typeof deviations)[number]).level !== '正常'" :type="(scope.row as (typeof deviations)[number]).level === '超出常见区间' ? 'danger' : 'warning'" size="small">
              {{ (scope.row as (typeof deviations)[number]).message }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>

      <el-form ref="formRef" label-width="92px" class="dialog-form">
        <el-form-item label="复核结论">
          <el-radio-group v-model="dialogStatus">
            <el-radio-button v-for="status in ['维持原值', '存疑', '复测', '已修正', '两边不符'] as ReviewStatus[]" :key="status" :value="status">
              {{ status }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="dialogStatus === '存疑'" label="存疑项">
          <el-checkbox-group v-model="doubtKeys">
            <el-checkbox v-for="field in MEASURE_FIELDS" :key="field.key" :value="field.key">{{ field.label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item v-if="dialogStatus === '复测'" label="复测项">
          <el-checkbox-group v-model="remeasureKeys">
            <el-checkbox v-for="field in MEASURE_FIELDS" :key="field.key" :value="field.key">{{ field.label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="复核说明">
          <el-input v-model="note" type="textarea" :rows="2" maxlength="200" show-word-limit placeholder="存疑原因 / 复测要求 / 修正依据" />
        </el-form-item>
        <el-form-item label="复核人">
          <el-input v-model="reviewer" style="width: 200px" maxlength="16" placeholder="复核人" />
        </el-form-item>
      </el-form>

      <el-alert
        type="info"
        :closable="false"
        title="提交后：现场原始数值照原样保留；修正值只存在复核侧。写库失败会自动进入待重试队列。"
      />

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">提交复核结论</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  color: #1f4a44;
}
.page-desc {
  margin: 0 0 12px;
  color: #6f8480;
  font-size: 13px;
}
.outbox-alert {
  margin-bottom: 12px;
}
.outbox-actions {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.review-tabs {
  margin-bottom: 4px;
}
.tab-badge {
  margin-left: 4px;
}
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-note {
  font-size: 12px;
  color: #8a99a5;
}
.cell-sub {
  font-size: 12px;
  color: #8a99a5;
}
.mismatch-text {
  color: #c62828;
}
.recompare-text {
  color: #c77700;
}
.is-corrected {
  color: #2f7d6f;
  font-weight: 600;
}
.key-tag {
  margin: 0 4px 2px 0;
}
.baseline-form {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 12px;
}
.baseline-table {
  margin-bottom: 8px;
}
.dialog-baseline {
  margin-bottom: 10px;
}
.dialog-table {
  margin-bottom: 12px;
}
.raw-value {
  font-weight: 600;
  color: #1f4a44;
}
.dev-line {
  font-size: 12px;
  color: #2f4a44;
  line-height: 1.6;
}
.dialog-form {
  margin-top: 4px;
}
</style>
