<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import MeasureInput from '../components/common/MeasureInput.vue';
import SpeciesPicker from '../components/common/SpeciesPicker.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import { useRingStore } from '../stores/ringStore';
import { useMeasureStore } from '../stores/measureStore';
import { useReviewStore } from '../stores/reviewStore';
import { MEASURE_FIELDS, isClosedStatus, quarterOf, type MeasureKey, type Morphometrics } from '../types/morphometrics';
import { deviationsOf, effectiveValuesOf, provisionalBaselines } from '../utils/stats';
import { formatDateTime } from '../utils/format';

const ringStore = useRingStore();
const measureStore = useMeasureStore();
const reviewStore = useReviewStore();

const selectedRingId = ref(ringStore.rings[0]?.id ?? '');
const speciesCn = ref(ringStore.rings[0]?.speciesCn ?? '红喉歌鸲');
const speciesSci = ref(ringStore.rings[0]?.speciesSci ?? 'Calliope calliope');
const dialogVisible = ref(false);
const formRef = ref<FormInstance>();

interface MorphForm extends Record<MeasureKey, number> {
  fatScore: number;
  measuredBy: string;
  measuredAt: string;
}

const form = ref<MorphForm>({
  billLength: 12,
  billWidth: 4,
  wingLength: 70,
  tailLength: 55,
  tarsusLength: 20,
  weight: 20,
  fatScore: 2,
  measuredBy: '韩雪',
  measuredAt: new Date().toISOString().slice(0, 10),
});

const rules: FormRules = {
  measuredBy: [{ required: true, message: '请输入测量人', trigger: 'blur' }],
};

const ringOptions = computed(() =>
  ringStore.rings.map((record) => ({ label: `${record.ringNo} · ${record.speciesCn} · ${record.netNo}`, value: record.id })),
);

const selectedRing = computed(() => ringStore.rings.find((record) => record.id === selectedRingId.value));

/** 各「季度 × 鸟种」的试算均线（资料室核定后改用核定均线） */
const currentQuarter = computed(() => quarterOf(new Date().toISOString()));
const provisionalByQuarter = computed(() =>
  provisionalBaselines(ringStore.rings, measureStore.morphs, reviewStore.reviews),
);
const currentBaseline = computed(() => {
  const approved = reviewStore.baselineOf(speciesCn.value, currentQuarter.value);
  if (approved) return { values: approved.values, approved: true };
  return { values: provisionalByQuarter.value[currentQuarter.value]?.[speciesCn.value], approved: false };
});
const measuredSpeciesCount = computed(() =>
  new Set(
    measureStore.morphs
      .map((morph) => ringStore.rings.find((record) => record.id === morph.ringId)?.speciesCn)
      .filter(Boolean) as string[],
  ).size,
);

const liveDeviations = computed(() =>
  deviationsOf(
    MEASURE_FIELDS.reduce((acc, field) => {
      acc[field.key] = Number(form.value[field.key]) || 0;
      return acc;
    }, {} as Record<MeasureKey, number>),
    speciesCn.value,
    currentBaseline.value.values,
    currentBaseline.value.approved,
  ),
);

const deviationMap = computed(() => new Map(liveDeviations.value.map((item) => [item.key, item])));

const morphRows = computed(() =>
  measureStore.morphs.map((morph) => {
    const ring = ringStore.rings.find((record) => record.id === morph.ringId);
    const species = ring?.speciesCn ?? '';
    const quarter = quarterOf(morph.measuredAt);
    const review = reviewStore.reviewByMorph(morph.id);
    // 已定论的复核用结论当时的均线快照（核定后不再重算）；未定论用核定均线或当季试算均线
    const approved = reviewStore.baselineOf(species, quarter);
    const baseline =
      (isClosedStatus(review?.status ?? '待复核') ? review?.baselineSnapshot : undefined) ??
      approved?.values ??
      provisionalByQuarter.value[quarter]?.[species];
    const deviations = deviationsOf(effectiveValuesOf(morph, review), species, baseline, !!approved);
    return {
      morph,
      review,
      ringNo: ring?.ringNo ?? '未知环号',
      species,
      warnings: deviations.filter((item) => item.level !== '正常'),
    };
  }),
);

const meanRows = computed(() =>
  MEASURE_FIELDS.map((field) => ({
    key: field.key,
    label: `${field.label}(${field.unit})`,
    baseline: currentBaseline.value.values?.[field.key],
  })),
);

watch(selectedRing, (ring) => {
  if (ring) {
    speciesCn.value = ring.speciesCn;
    speciesSci.value = ring.speciesSci;
  }
});

function openCreate() {
  if (!selectedRing.value) {
    ElMessage.warning('请先选择一条环志记录');
    return;
  }
  if (measureStore.byRing(selectedRing.value.id)) {
    ElMessage.warning('该环志记录已有现场量度；原始数值不可改，确需更正请由资料室在复核侧另存修正值');
    return;
  }
  formRef.value?.clearValidate();
  const values = currentBaseline.value.values;
  form.value = {
    billLength: values?.billLength?.mean || 12,
    billWidth: values?.billWidth?.mean || 4,
    wingLength: values?.wingLength?.mean || 70,
    tailLength: values?.tailLength?.mean || 55,
    tarsusLength: values?.tarsusLength?.mean || 20,
    weight: values?.weight?.mean || 20,
    fatScore: 2,
    measuredBy: '韩雪',
    measuredAt: new Date().toISOString().slice(0, 10),
  };
  dialogVisible.value = true;
}

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;
  if (!selectedRing.value) {
    ElMessage.warning('请先选择一条环志记录');
    return;
  }
  const payload = {
    ringId: selectedRing.value.id,
    billLength: Number(form.value.billLength) || 0,
    billWidth: Number(form.value.billWidth) || 0,
    wingLength: Number(form.value.wingLength) || 0,
    tailLength: Number(form.value.tailLength) || 0,
    tarsusLength: Number(form.value.tarsusLength) || 0,
    weight: Number(form.value.weight) || 0,
    fatScore: Number(form.value.fatScore) || 0,
    measuredBy: form.value.measuredBy,
    measuredAt: new Date(`${form.value.measuredAt}T09:00:00`).toISOString(),
  };
  await measureStore.addMorph(payload);
  await reviewStore.hydrate();
  const warnings = liveDeviations.value.filter((item) => item.level !== '正常');
  ElMessage.success(
    warnings.length
      ? `已录入 ${selectedRing.value.ringNo} 现场量度（原始数值锁定），${warnings.length} 项偏离本季均线，已转资料室复核`
      : `已录入 ${selectedRing.value.ringNo} 现场量度（原始数值锁定），已转资料室复核`,
  );
  dialogVisible.value = false;
}

async function remove(morph: Morphometrics) {
  const confirmed = await ElMessageBox.confirm(
    `确认删除 ${ringStore.rings.find((r) => r.id === morph.ringId)?.ringNo ?? ''} 的现场量度记录？该操作同时撤回资料室复核单。`,
    '删除确认',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await measureStore.removeMorph(morph.id);
  await reviewStore.hydrate();
  ElMessage.success('已删除现场量度及其复核单');
}

const reviewTagType: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'primary'> = {
  待复核: 'info',
  维持原值: 'success',
  存疑: 'warning',
  复测: 'danger',
  已修正: 'primary',
  两边不符: 'danger',
};
</script>

<template>
  <div>
    <h2 class="page-title">量度测量录入 · 环志组（现场原始数值）</h2>
    <p class="page-desc">
      本页只登记现场测得的原始数值，录入后即锁定、不可直接改动；资料室在
      <el-link type="primary" :underline="false" href="/review">复核台</el-link>
      给出结论，存疑 / 复测 / 修正值都记在复核侧，现场原始数值照原样留着。
    </p>

    <el-card shadow="never" class="block">
      <div class="head-row">
        <span class="head-label">选择环志记录</span>
        <el-select v-model="selectedRingId" filterable placeholder="按环号 / 鸟种搜索" style="width: 320px">
          <el-option v-for="item in ringOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-button type="primary" :disabled="!selectedRing" @click="openCreate">录入量度</el-button>
        <el-tag v-if="selectedRing" type="success" effect="plain">
          已选 {{ selectedRing.ringNo }} · {{ selectedRing.speciesCn }} · {{ selectedRing.age }}
        </el-tag>
      </div>
      <SpeciesPicker v-model:species-cn="speciesCn" v-model:species-sci="speciesSci" label="比对鸟种" />
    </el-card>

    <el-row :gutter="16">
      <el-col :xs="24" :lg="8">
        <el-card shadow="never" class="block">
          <template #header>
            <div class="card-head">
              <span>同鸟种{{ currentQuarter }}均线</span>
              <el-tag size="small" :type="currentBaseline.approved ? 'success' : 'info'" effect="plain">
                {{ currentBaseline.approved ? '资料室已核定' : '未核定·试算' }}
              </el-tag>
            </div>
          </template>
          <div class="card-note mean-note">{{ speciesCn }} · 已量度 {{ measuredSpeciesCount }} 种鸟</div>
          <div v-for="row in meanRows" :key="row.key" class="mean-row">
            <span>{{ row.label }}</span>
            <span class="mean-value">
              <template v-if="row.baseline && row.baseline.mean">
                {{ row.baseline.mean }}
                <span class="mean-std">±{{ row.baseline.std }}（n={{ row.baseline.count }}）</span>
              </template>
              <template v-else>—</template>
            </span>
          </div>
          <div class="card-note mean-note">均线 = 样本均值；±后为统计值（样本标准差）</div>
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="16">
        <el-card shadow="never" class="block">
          <template #header>
            <div class="card-head">
              <span>现场量度记录（{{ morphRows.length }} 条）</span>
              <span class="card-note">原始数值锁定，偏离项同时标出均线偏离 % 与统计偏离 σ</span>
            </div>
          </template>
          <EmptyPanel v-if="morphRows.length === 0" description="暂无量度记录" action-text="录入量度" @action="openCreate" />
          <el-table v-else :data="morphRows" size="small" border>
            <el-table-column label="环号" width="100">
              <template #default="scope">{{ scope.row.ringNo }}</template>
            </el-table-column>
            <el-table-column label="鸟种" width="96">
              <template #default="scope">{{ scope.row.species }}</template>
            </el-table-column>
            <el-table-column label="喙长×喙宽(mm)" width="130">
              <template #default="scope">
                {{ scope.row.morph.billLength }} × {{ scope.row.morph.billWidth }}
              </template>
            </el-table-column>
            <el-table-column label="翅长(mm)" width="86">
              <template #default="scope">{{ scope.row.morph.wingLength }}</template>
            </el-table-column>
            <el-table-column label="尾长(mm)" width="86">
              <template #default="scope">{{ scope.row.morph.tailLength }}</template>
            </el-table-column>
            <el-table-column label="跗跖(mm)" width="86">
              <template #default="scope">{{ scope.row.morph.tarsusLength }}</template>
            </el-table-column>
            <el-table-column label="体重(g)" width="86">
              <template #default="scope">{{ scope.row.morph.weight }}</template>
            </el-table-column>
            <el-table-column label="肥满度" width="74">
              <template #default="scope">{{ scope.row.morph.fatScore }}</template>
            </el-table-column>
            <el-table-column label="资料室复核" width="92">
              <template #default="scope">
                <el-tag :type="reviewTagType[scope.row.review?.status ?? '待复核'] ?? 'info'" size="small">
                  {{ scope.row.review?.status ?? '待复核' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="偏离提示（均线 / 统计）" min-width="220">
              <template #default="scope">
                <el-tag v-if="scope.row.warnings.length === 0" type="success" size="small">正常</el-tag>
                <el-tag
                  v-for="warn in scope.row.warnings"
                  :key="warn.key"
                  :type="warn.level === '超出常见区间' ? 'danger' : 'warning'"
                  size="small"
                  class="warn-tag"
                >
                  {{ warn.message }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="测量人 / 时间" width="156">
              <template #default="scope">{{ scope.row.morph.measuredBy }} · {{ formatDateTime(scope.row.morph.measuredAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="scope">
                <el-tooltip content="现场原始数值锁定不可改；确需更正请由资料室另存修正值" placement="top">
                  <el-button link type="danger" @click="remove(scope.row.morph)">删除</el-button>
                </el-tooltip>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialogVisible" :title="`录入现场量度 · ${selectedRing?.ringNo ?? ''}`" width="760px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-row :gutter="16">
          <el-col v-for="field in MEASURE_FIELDS" :key="field.key" :xs="24" :md="12">
            <MeasureInput
              :field="field"
              :model-value="form[field.key]"
              :deviation="deviationMap.get(field.key)"
              @update:model-value="(value: number) => (form[field.key] = value)"
            />
          </el-col>
        </el-row>
        <el-form-item label="肥满度(0~4)">
          <el-input-number v-model="form.fatScore" :min="0" :max="4" placeholder="肥满度" />
        </el-form-item>
        <el-form-item label="测量人" prop="measuredBy">
          <el-input v-model="form.measuredBy" style="width: 160px" maxlength="16" placeholder="测量人" />
        </el-form-item>
        <el-form-item label="测量日期">
          <el-date-picker v-model="form.measuredAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="liveDeviations.filter((item) => item.level !== '正常').length"
        type="warning"
        show-icon
        :closable="false"
        :title="`${liveDeviations.filter((item) => item.level !== '正常').length} 项偏离本季均线或常见区间`"
        :description="liveDeviations.filter((item) => item.level !== '正常').map((item) => item.message).join('；')"
      />
      <el-alert v-else type="success" show-icon :closable="false" title="各项量度均在常见区间内" />
      <el-alert type="info" :closable="false" title="保存后现场原始数值即锁定，不能在本页改动；更正由资料室另存修正值。" class="lock-alert" />
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存原始数值</el-button>
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
.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.head-label {
  font-size: 13px;
  color: #2f4a44;
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
.mean-note {
  margin: 4px 0;
}
.mean-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  padding: 4px 0;
  color: #2f4a44;
}
.mean-value {
  font-weight: 600;
  color: #2f7d6f;
}
.mean-std {
  font-weight: 400;
  color: #8a99a5;
  font-size: 12px;
}
.warn-tag {
  margin: 0 4px 2px 0;
}
.lock-alert {
  margin-top: 8px;
}
</style>
