<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { useRingStore } from '../stores/ringStore';
import { useMeasureStore } from '../stores/measureStore';
import { useMeanStore } from '../stores/meanStore';
import {
  MEASURE_FIELDS,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TAG_TYPE,
  correctionDiff,
  fieldValuesOf,
  hasCorrections,
  isConcluded,
  type MeasureKey,
  type Morphometrics,
  type ReviewStatus,
} from '../types/morphometrics';
import { currentQuarter, quarterLabel, type SpeciesMean } from '../types/species-mean';
import { meansOf } from '../utils/stats';
import { formatDateTime } from '../utils/format';

const ringStore = useRingStore();
const measureStore = useMeasureStore();
const meanStore = useMeanStore();

const activeTab = ref('queue');

function ringOf(morph: Morphometrics) {
  return ringStore.rings.find((ring) => ring.id === morph.ringId);
}

/** 待复核队列（未定论） */
const queueRows = computed(() =>
  measureStore.reviewQueue.map((morph) => {
    const ring = ringOf(morph);
    const status = morph.review?.status ?? 'pending';
    return {
      morph,
      ringNo: ring?.ringNo ?? '未知环号',
      species: ring?.speciesCn ?? '',
      status,
      statusLabel: REVIEW_STATUS_LABELS[status],
      statusType: REVIEW_STATUS_TAG_TYPE[status],
      recompare: !!morph.review?.recompareAt && status !== 'confirmed',
    };
  }),
);

/** 对不上清单：存疑 / 待复测 / 有修正值 */
const mismatchRows = computed(() =>
  measureStore.mismatchList.map((morph) => {
    const ring = ringOf(morph);
    const status = morph.review?.status ?? 'pending';
    return {
      morph,
      ringNo: ring?.ringNo ?? '未知环号',
      species: ring?.speciesCn ?? '',
      status,
      statusLabel: REVIEW_STATUS_LABELS[status],
      statusType: REVIEW_STATUS_TAG_TYPE[status],
      diff: correctionDiff(morph),
    };
  }),
);

/** 均线核定：按鸟种汇总 */
const quarter = currentQuarter();
const speciesRows = computed(() => {
  const map = new Map<string, { count: number; concluded: number }>();
  measureStore.morphs.forEach((morph) => {
    const ring = ringOf(morph);
    if (!ring) return;
    const item = map.get(ring.speciesCn) ?? { count: 0, concluded: 0 };
    item.count += 1;
    if (isConcluded(morph)) item.concluded += 1;
    map.set(ring.speciesCn, item);
  });
  return Array.from(map.entries())
    .map(([species, value]) => ({ species, ...value }))
    .sort((a, b) => b.count - a.count);
});

/** 现场均值（全部记录的现场原始数值） */
const fieldMeans = computed(() => meansOf(ringStore.rings, measureStore.morphs, 'field', false));
/** 定论均值（已定论记录的定论采用值）—— 核定参考 */
const officialMeans = computed(() => meansOf(ringStore.rings, measureStore.morphs, 'official', true));

function approvedMean(species: string): SpeciesMean | undefined {
  return meanStore.approvedFor(species, quarter);
}

async function approve(species: string) {
  const suggested = officialMeans.value[species];
  if (!suggested || !Object.values(suggested).some((value) => value > 0)) {
    ElMessage.warning('该鸟种暂无定论记录，无法核定均线');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `按 ${quarterLabel(quarter)} 定论记录核定「${species}」均线？核定后还没定论的重新比对，定了论的结论和原始数值都不动。`,
      '均线核定',
      { type: 'info', confirmButtonText: '核定本季均线' },
    );
  } catch {
    return;
  }
  await meanStore.approveMean(species, suggested, '资料室');
  ElMessage.success(`已核定「${species}」${quarterLabel(quarter)}均线，未定论记录已重新比对`);
}

/** 复核对话框 */
const dialogVisible = ref(false);
const reviewing = ref<Morphometrics | null>(null);
const formRef = ref<FormInstance>();
const reviewForm = ref({
  status: 'confirmed' as ReviewStatus,
  doubtNote: '',
  remeasureRequest: '',
  needCorrection: false,
  corrections: {} as Record<MeasureKey, number>,
  reviewer: '资料室',
  note: '',
});
const submitState = ref<'idle' | 'submitting' | 'failed'>('idle');
const submitError = ref('');
const simulateFailure = ref(false);

const reviewRules: FormRules = {
  doubtNote: [{ required: true, message: '请填写存疑说明', trigger: 'blur' }],
  remeasureRequest: [{ required: true, message: '请填写复测要求', trigger: 'blur' }],
};

const reviewingRingNo = computed(() => {
  if (!reviewing.value) return '';
  return ringOf(reviewing.value)?.ringNo ?? '未知环号';
});

function openReview(morph: Morphometrics) {
  reviewing.value = morph;
  const status = morph.review?.status ?? 'pending';
  reviewForm.value = {
    status: status === 'pending' ? 'confirmed' : status,
    doubtNote: morph.review?.doubtNote ?? '',
    remeasureRequest: morph.review?.remeasureRequest ?? '',
    needCorrection: hasCorrections(morph),
    corrections: hasCorrections(morph)
      ? { ...(morph.review?.corrections as Record<MeasureKey, number>) }
      : { ...fieldValuesOf(morph) },
    reviewer: morph.review?.reviewer ?? '资料室',
    note: morph.review?.note ?? '',
  };
  submitState.value = 'idle';
  submitError.value = '';
  simulateFailure.value = false;
  dialogVisible.value = true;
}

/** 提交复核结论；失败后停在失败态，可重试 */
async function submitReview() {
  if (!reviewing.value) return;
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;
  submitState.value = 'submitting';
  submitError.value = '';

  const corrections = reviewForm.value.needCorrection
    ? MEASURE_FIELDS.reduce(
        (acc, field) => {
          const value = Number(reviewForm.value.corrections[field.key]) || 0;
          if (value > 0 && value !== fieldValuesOf(reviewing.value!)[field.key]) {
            acc[field.key] = value;
          }
          return acc;
        },
        {} as Record<MeasureKey, number>,
      )
    : undefined;

  const payload = {
    status: reviewForm.value.status,
    reviewer: reviewForm.value.reviewer.trim() || '资料室',
    reviewedAt: new Date().toISOString(),
    doubtNote: reviewForm.value.status === 'doubtful' ? reviewForm.value.doubtNote.trim() : undefined,
    remeasureRequest: reviewForm.value.status === 'remeasure' ? reviewForm.value.remeasureRequest.trim() : undefined,
    corrections: corrections && Object.keys(corrections).length ? corrections : undefined,
    note: reviewForm.value.note.trim() || undefined,
  };

  try {
    await measureStore.submitReview(reviewing.value.id, payload, { simulateFailure: simulateFailure.value });
    submitState.value = 'idle';
    dialogVisible.value = false;
    ElMessage.success('复核结论已提交');
  } catch (error) {
    submitState.value = 'failed';
    submitError.value = (error as Error).message;
  }
}
</script>

<template>
  <div>
    <h2 class="page-title">量度复核</h2>
    <p class="page-desc">
      环志组管现场测的原始数值，资料室管复核结论。存疑和复测要求写在复核侧，原始数值照原样留着；确实要更正就另存修正值。同鸟种均线由资料室按季核定，核定后还没定论的重新比对，定了论的结论和原始数值都不动。
    </p>

    <el-row :gutter="12" class="stat-row">
      <el-col :xs="12" :md="6">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">待复核</div>
          <div class="stat-value">{{ measureStore.reviewQueue.length }}</div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">未复核</div>
          <div class="stat-value stat-warning">{{ measureStore.pendingCount }}</div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">存疑 / 待复测</div>
          <div class="stat-value stat-danger">
            {{ measureStore.mismatchList.filter((m) => m.review?.status === 'doubtful' || m.review?.status === 'remeasure').length }}
          </div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">已定论</div>
          <div class="stat-value stat-success">
            {{ measureStore.morphs.filter((m) => m.review?.status === 'confirmed').length }}
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="block">
      <el-tabs v-model="activeTab">
        <el-tab-pane name="queue">
          <template #label>
            <span>待复核</span>
            <el-badge v-if="measureStore.reviewQueue.length" :value="measureStore.reviewQueue.length" class="tab-badge" type="warning" />
          </template>
          <el-table :data="queueRows" size="small" border>
            <el-table-column label="环号" width="110">
              <template #default="scope">{{ scope.row.ringNo }}</template>
            </el-table-column>
            <el-table-column label="鸟种" width="110">
              <template #default="scope">{{ scope.row.species }}</template>
            </el-table-column>
            <el-table-column label="现场数值" min-width="260">
              <template #default="scope">
                <div class="field-values">
                  <span v-for="field in MEASURE_FIELDS" :key="field.key" class="field-chip">
                    {{ field.label }}
                    <b>{{ scope.row.morph[field.key] }}</b>
                    <i>{{ field.unit }}</i>
                  </span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="scope">
                <el-tag :type="scope.row.statusType" size="small" effect="plain">{{ scope.row.statusLabel }}</el-tag>
                <el-tag v-if="scope.row.recompare" type="warning" size="small" effect="plain" class="recompare-tag">
                  待重新比对
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="存疑 / 复测说明" min-width="180">
              <template #default="scope">
                <span v-if="scope.row.morph.review?.doubtNote" class="note-doubt">存疑：{{ scope.row.morph.review.doubtNote }}</span>
                <span v-if="scope.row.morph.review?.remeasureRequest" class="note-remeasure">
                  复测：{{ scope.row.morph.review.remeasureRequest }}
                </span>
                <span v-if="!scope.row.morph.review?.doubtNote && !scope.row.morph.review?.remeasureRequest" class="card-note">—</span>
              </template>
            </el-table-column>
            <el-table-column label="测量人 / 时间" width="160">
              <template #default="scope">{{ scope.row.morph.measuredBy }} · {{ formatDateTime(scope.row.morph.measuredAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="100" fixed="right">
              <template #default="scope">
                <el-button link type="primary" @click="openReview(scope.row.morph)">复核</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane name="means">
          <template #label>
            <span>均线核定</span>
            <el-tag size="small" effect="plain" class="tab-tag">{{ quarterLabel(quarter) }}</el-tag>
          </template>
          <el-alert
            type="info"
            show-icon
            :closable="false"
            title="同鸟种均线由资料室按季核定"
            description="核定依据为已定论记录的定论采用值（有修正值取修正值）。核定后还没定论的记录重新比对，定了论的结论和原始数值都不动。"
            class="mean-alert"
          />
          <el-table :data="speciesRows" size="small" border>
            <el-table-column label="鸟种" width="140">
              <template #default="scope">{{ scope.row.species }}</template>
            </el-table-column>
            <el-table-column label="记录 / 定论" width="110">
              <template #default="scope">{{ scope.row.count }} / {{ scope.row.concluded }}</template>
            </el-table-column>
            <el-table-column label="建议均线（定论记录）" min-width="280">
              <template #default="scope">
                <div class="field-values">
                  <span v-for="field in MEASURE_FIELDS" :key="field.key" class="field-chip">
                    {{ field.label }}
                    <b>{{ officialMeans[scope.row.species]?.[field.key] || '—' }}</b>
                    <i>{{ field.unit }}</i>
                  </span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="现场均值（原始数值）" min-width="280">
              <template #default="scope">
                <div class="field-values">
                  <span v-for="field in MEASURE_FIELDS" :key="field.key" class="field-chip field-chip-plain">
                    {{ field.label }}
                    <b>{{ fieldMeans[scope.row.species]?.[field.key] || '—' }}</b>
                    <i>{{ field.unit }}</i>
                  </span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="本季核定" width="120">
              <template #default="scope">
                <el-tag v-if="approvedMean(scope.row.species)" type="success" size="small" effect="plain">已核定</el-tag>
                <el-tag v-else type="info" size="small" effect="plain">未核定</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="scope">
                <el-button type="primary" size="small" @click="approve(scope.row.species)">
                  {{ approvedMean(scope.row.species) ? '重新核定' : '核定本季均线' }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane name="mismatch">
          <template #label>
            <span>对不上清单</span>
            <el-badge v-if="mismatchRows.length" :value="mismatchRows.length" class="tab-badge" type="danger" />
          </template>
          <el-table :data="mismatchRows" size="small" border>
            <el-table-column label="环号" width="110">
              <template #default="scope">{{ scope.row.ringNo }}</template>
            </el-table-column>
            <el-table-column label="鸟种" width="110">
              <template #default="scope">{{ scope.row.species }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="scope">
                <el-tag :type="scope.row.statusType" size="small" effect="plain">{{ scope.row.statusLabel }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="两边对照（原始 → 修正）" min-width="260">
              <template #default="scope">
                <span v-if="scope.row.diff.length === 0" class="card-note">无数值更正</span>
                <div v-for="item in scope.row.diff" :key="item.key" class="diff-row">
                  <span class="diff-label">{{ item.label }}</span>
                  <span class="diff-original">{{ item.original }}</span>
                  <span class="diff-arrow">→</span>
                  <span class="diff-corrected">{{ item.corrected }}</span>
                  <span class="diff-unit">{{ item.unit }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="存疑 / 复测说明" min-width="180">
              <template #default="scope">
                <span v-if="scope.row.morph.review?.doubtNote" class="note-doubt">存疑：{{ scope.row.morph.review.doubtNote }}</span>
                <span v-if="scope.row.morph.review?.remeasureRequest" class="note-remeasure">
                  复测：{{ scope.row.morph.review.remeasureRequest }}
                </span>
                <span v-if="!scope.row.morph.review?.doubtNote && !scope.row.morph.review?.remeasureRequest" class="card-note">—</span>
              </template>
            </el-table-column>
            <el-table-column label="复核人 / 时间" width="160">
              <template #default="scope">
                <span v-if="scope.row.morph.review?.reviewer">
                  {{ scope.row.morph.review.reviewer }} · {{ formatDateTime(scope.row.morph.review.reviewedAt ?? '') }}
                </span>
                <span v-else class="card-note">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100" fixed="right">
              <template #default="scope">
                <el-button link type="primary" @click="openReview(scope.row.morph)">
                  {{ scope.row.status === 'confirmed' ? '查看' : '去复核' }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="`复核量度 · ${reviewingRingNo}`" width="760px">
      <template v-if="reviewing">
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="现场原始数值（环志组录入，照原样保留，不可更改）"
          class="field-alert"
        >
          <div class="field-values">
            <span v-for="field in MEASURE_FIELDS" :key="field.key" class="field-chip">
              {{ field.label }}
              <b>{{ reviewing[field.key] }}</b>
              <i>{{ field.unit }}</i>
            </span>
            <span class="field-chip field-chip-meta">
              {{ reviewing.measuredBy }} · {{ formatDateTime(reviewing.measuredAt) }}
            </span>
          </div>
        </el-alert>

        <el-form ref="formRef" :model="reviewForm" :rules="reviewRules" label-width="110px" class="review-form">
          <el-form-item label="复核结论" prop="status">
            <el-radio-group v-model="reviewForm.status">
              <el-radio value="confirmed">确认无误（定论）</el-radio>
              <el-radio value="doubtful">存疑</el-radio>
              <el-radio value="remeasure">待复测</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="reviewForm.status === 'doubtful'" label="存疑说明" prop="doubtNote">
            <el-input v-model="reviewForm.doubtNote" type="textarea" :rows="2" placeholder="填写存疑项与原因，写在复核侧" />
          </el-form-item>
          <el-form-item v-if="reviewForm.status === 'remeasure'" label="复测要求" prop="remeasureRequest">
            <el-input v-model="reviewForm.remeasureRequest" type="textarea" :rows="2" placeholder="填写需要复测的项目与要求" />
          </el-form-item>
          <el-form-item label="更正数值">
            <el-checkbox v-model="reviewForm.needCorrection">数值有误，需另存修正值（不覆盖现场原值）</el-checkbox>
          </el-form-item>
          <template v-if="reviewForm.needCorrection">
            <el-row :gutter="16">
              <el-col v-for="field in MEASURE_FIELDS" :key="field.key" :xs="24" :md="12">
                <el-form-item :label="`${field.label}(${field.unit})`">
                  <el-input-number
                    v-model="reviewForm.corrections[field.key]"
                    :min="0"
                    :step="field.step"
                    :precision="1"
                    :placeholder="`现场原值 ${reviewing[field.key]}`"
                    style="width: 100%"
                  />
                </el-form-item>
              </el-col>
            </el-row>
          </template>
          <el-form-item label="复核人">
            <el-input v-model="reviewForm.reviewer" style="width: 160px" maxlength="16" placeholder="复核人" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="reviewForm.note" placeholder="复核备注（可选）" />
          </el-form-item>
        </el-form>

        <el-alert
          v-if="submitState === 'failed'"
          type="error"
          show-icon
          :closable="false"
          class="submit-alert"
          title="复核提交失败"
          :description="submitError"
        >
          <div class="submit-retry">
            <el-button type="primary" size="small" @click="submitReview">重试提交</el-button>
          </div>
        </el-alert>
      </template>
      <template #footer>
        <div class="dialog-footer">
          <el-checkbox v-model="simulateFailure" class="simulate-failure">模拟提交失败（演示重试）</el-checkbox>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="submitState === 'submitting'" @click="submitReview">
            {{ submitState === 'failed' ? '重新提交' : '提交复核' }}
          </el-button>
        </div>
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
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.stat-row {
  margin-bottom: 12px;
}
.stat-card {
  margin-bottom: 12px;
  text-align: center;
}
.stat-label {
  font-size: 13px;
  color: #6f8480;
}
.stat-value {
  font-size: 26px;
  font-weight: 700;
  color: #2f7d6f;
  margin-top: 4px;
}
.stat-warning {
  color: #c77700;
}
.stat-danger {
  color: #c62828;
}
.stat-success {
  color: #2e7d32;
}
.card-note {
  font-size: 12px;
  color: #8a99a5;
}
.tab-badge {
  margin-left: 6px;
  margin-top: -2px;
}
.tab-tag {
  margin-left: 6px;
}
.recompare-tag {
  margin-top: 2px;
}
.field-values {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.field-chip {
  font-size: 12px;
  color: #6f8480;
  white-space: nowrap;
}
.field-chip b {
  color: #1f4a44;
  font-size: 13px;
  margin: 0 2px;
}
.field-chip i {
  font-style: normal;
  color: #8a99a5;
}
.field-chip-plain b {
  color: #5a6b73;
}
.field-chip-meta {
  color: #8a99a5;
}
.note-doubt {
  display: block;
  font-size: 12px;
  color: #c77700;
  line-height: 1.6;
}
.note-remeasure {
  display: block;
  font-size: 12px;
  color: #c62828;
  line-height: 1.6;
}
.diff-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  line-height: 1.6;
}
.diff-label {
  color: #6f8480;
  min-width: 42px;
}
.diff-original {
  color: #8a99a5;
  text-decoration: line-through;
}
.diff-arrow {
  color: #c77700;
}
.diff-corrected {
  color: #c62828;
  font-weight: 600;
}
.diff-unit {
  color: #8a99a5;
}
.mean-alert {
  margin-bottom: 12px;
}
.field-alert {
  margin-bottom: 16px;
}
.review-form {
  margin-top: 4px;
}
.submit-alert {
  margin-top: 12px;
}
.submit-retry {
  margin-top: 8px;
}
.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
}
.simulate-failure {
  margin-right: auto;
}
</style>
