<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与可追溯绳套定线
 * - 点据记住来源断面 / 垂线 / 测点与流量快照；缺来源或方向不明留在待确认；
 * - 每测站 × 线号维护版本化绳套曲线（涨水 / 退水两支分别拟合）；
 * - 原始测次补录 / 重测后点据转待复核、旧曲线失效，经复核面板试算 / 确认 / 回滚；
 * - 水位重叠且两支交叉的测次先列冲突，确认前必须处理。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, TrendCharts, WarningFilled } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ReviewPanel from '@/components/rating/ReviewPanel.vue'
import ProvenanceTag from '@/components/rating/ProvenanceTag.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useReviewStore } from '@/stores/reviewStore'
import type { Rating, TrendDirection, RatingPointStatus } from '@/types/rating'
import { TREND_DIRECTIONS, RATING_POINT_STATUSES, curveFlow } from '@/types/rating'
import { buildProvenanceSnapshot } from '@/utils/provenance'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const reviewStore = useReviewStore()

ratingStore.start()
reviewStore.start()
sectionStore.start()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  stationId: '',
  stageM: 0,
  flowM3s: 0,
  lineNo: 'A',
  direction: '涨水' as TrendDirection,
  sourceSectionId: '' as string,
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

/** 当前选中测站 × 线号 */
const activeStationId = computed(() => ratingStore.activeStationId || stationStore.stations[0]?.id || '')
const activeLineNo = computed(() => ratingStore.activeLineNo)

const stationOptions = computed(() =>
  stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
)

const lineOptions = computed(() => ratingStore.lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })))

/** 表单内：当前测站可作为来源的测次（选择后按成果自动拍快照） */
const sourceSectionOptions = computed(() =>
  sectionStore
    .sectionsOfStation(form.stationId)
    .map((section) => ({
      ...section,
      label: `${section.measureNo} · 水位 ${section.stageM.toFixed(2)} m`
    }))
)

const activeCurve = computed(() =>
  activeStationId.value ? reviewStore.activeCurve(activeStationId.value, activeLineNo.value) : null
)

const openBatch = computed(() =>
  activeStationId.value ? reviewStore.openBatch(activeStationId.value, activeLineNo.value) : null
)

/** 当前站线各状态点据 */
const scopedRatings = computed(() =>
  ratingStore.ratings
    .filter((rating) => rating.stationId === activeStationId.value && rating.lineNo === activeLineNo.value)
    .sort((a, b) => a.stageM - b.stageM)
)

const staleCount = computed(() => scopedRatings.value.filter((rating) => rating.snapshotStale).length)
const pendingCount = computed(
  () => scopedRatings.value.filter((rating) => rating.status !== '已确认').length
)

/** 点据行：带所属分支曲线流量与残差 */
const pointRows = computed(() =>
  scopedRatings.value.map((rating) => {
    const curve = activeCurve.value
    const branch =
      rating.direction === '涨水' ? curve?.risingBranch : rating.direction === '退水' ? curve?.fallingBranch : null
    const predicted =
      curve && rating.status === '已确认' && branch?.fit.valid ? curveFlow(branch.fit, rating.stageM) : 0
    const residualPct =
      predicted > 0 && rating.flowM3s > 0
        ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
        : 0
    const compare = ratingStore.compares.find((item) => item.ratingId === rating.id)
    const verdict = compare?.verdict ?? (Math.abs(residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格')
    const section = rating.sourceSectionId ? sectionStore.sectionById(rating.sourceSectionId) : null
    return { rating, predicted, residualPct, verdict, sectionMeasureNo: section?.measureNo ?? rating.measureNo }
  })
)

const statusTagType = (status: RatingPointStatus): 'success' | 'warning' | 'danger' =>
  status === '已确认' ? 'success' : status === '待复核' ? 'danger' : 'warning'

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  directions: ratingStore.filter.directions,
  statuses: ratingStore.filter.statuses,
  verdicts: ratingStore.filter.verdicts
}))

/** 关系曲线坐标：横轴水位、纵轴流量，涨 / 退两支分色绘制 */
const chart = computed(() => {
  const rows = pointRows.value
  const empty = {
    rising: '',
    falling: '',
    points: [] as Array<{ id: string; cx: number; cy: number; verdict: string; direction: TrendDirection; usable: boolean }>,
    stageMin: 0,
    stageMax: 0,
    flowMax: 0
  }
  if (rows.length === 0) return empty
  const stages = rows.map((row) => row.rating.stageM)
  const flows = rows.map((row) => row.rating.flowM3s)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...flows, 1) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)

  const toSamples = (direction: TrendDirection): string => {
    const branch = activeCurve.value
      ? direction === '涨水'
        ? activeCurve.value.risingBranch
        : activeCurve.value.fallingBranch
      : null
    if (!branch?.fit.valid) return ''
    const branchStages = rows
      .filter((row) => row.rating.direction === direction && row.rating.status === '已确认')
      .map((row) => row.rating.stageM)
    if (branchStages.length === 0) return ''
    const min = Math.min(...branchStages)
    const max = Math.max(...branchStages)
    return Array.from({ length: 13 }, (_, index) => {
      const stageM = min + ((max - min) * index) / 12
      const value = curveFlow(branch.fit, stageM)
      return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
    }).join(' ')
  }

  return {
    rising: toSamples('涨水'),
    falling: toSamples('退水'),
    points: rows.map((row) => ({
      id: row.rating.id,
      cx: toX(row.rating.stageM),
      cy: toY(row.rating.flowM3s),
      verdict: row.verdict,
      direction: row.rating.direction,
      usable: row.rating.status === '已确认'
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

function handleStationChange(stationId: string | number | boolean | undefined): void {
  ratingStore.setActiveStation(String(stationId))
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
}

/** 选择来源测次后按垂线测点成果自动拍快照回填水位 / 流量 / 方向（按时间序列推断） */
function handleSourceSectionChange(sectionId: string | number | boolean | undefined): void {
  const id = String(sectionId ?? '')
  form.sourceSectionId = id
  if (!id) return
  const section = sectionStore.sectionById(id)
  if (!section) return
  const verticals = sectionStore.verticalsOfSection(id)
  const points = verticals.flatMap((vertical) => sectionStore.pointsOfVertical(vertical.id))
  if (verticals.length > 0) {
    const provenance = buildProvenanceSnapshot({ section, verticals, points })
    form.stageM = provenance.snapshot.stageM
    form.flowM3s = provenance.snapshot.flowM3s
  } else {
    form.stageM = section.stageM
  }
  form.measureNo = section.measureNo
  form.measuredAt = section.measuredAt.slice(0, 16)
  // 按该站测次水位序列推断涨 / 退方向
  const series = sectionStore.sectionsOfStation(form.stationId).map((item) => ({
    measureKey: item.measureNo,
    measuredAt: item.measuredAt,
    stageM: item.stageM
  }))
  const ordered = [...series].sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt))
  const index = ordered.findIndex((item) => item.measureKey === section.measureNo)
  if (index > 0) {
    form.direction = ordered[index].stageM >= ordered[index - 1].stageM ? '涨水' : '退水'
  }
}

function openCreate(): void {
  editingId.value = null
  form.stationId = activeStationId.value
  form.lineNo = activeLineNo.value
  form.direction = '涨水'
  form.sourceSectionId = ''
  const last = scopedRatings.value[scopedRatings.value.length - 1]
  form.stageM = last ? Number((last.stageM + 0.2).toFixed(2)) : 3
  form.flowM3s = last ? Number((last.flowM3s * 1.2).toFixed(1)) : 50
  form.measureNo = `${new Date().getFullYear()}-${String(ratingStore.ratings.length + 1).padStart(3, '0')}`
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.direction = rating.direction
  form.sourceSectionId = rating.sourceSectionId ?? ''
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写水位（m）')
    return
  }
  if (!Number.isFinite(form.flowM3s) || form.flowM3s <= 0) {
    ElMessage.warning('流量应为大于 0 的数字（m³/s）')
    return
  }
  submitting.value = true
  try {
    const section = form.sourceSectionId ? sectionStore.sectionById(form.sourceSectionId) : null
    const now = new Date().toISOString()
    let payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt'>

    if (section) {
      // 从来源测次落档：拍可追溯流量快照，登记来源垂线 / 测点
      const verticals = sectionStore.verticalsOfSection(section.id)
      const points = verticals.flatMap((vertical) => sectionStore.pointsOfVertical(vertical.id))
      const provenance = buildProvenanceSnapshot({ section, verticals, points }, now)
      const hasUsableDirection = form.direction !== '不明'
      payload = {
        stationId: form.stationId,
        stageM: provenance.snapshot.stageM,
        flowM3s: provenance.snapshot.flowM3s,
        lineNo: form.lineNo.trim() || 'A',
        measureNo: section.measureNo,
        measuredAt: section.measuredAt,
        sourceSectionId: section.id,
        sourceVerticalIds: provenance.sourceVerticalIds,
        sourcePoints: provenance.sourcePoints,
        snapshot: provenance.snapshot,
        snapshotStale: false,
        direction: form.direction,
        // 有完整来源且方向明确可直接确认；方向不明留在待确认
        status: hasUsableDirection ? '已确认' : '待确认',
        reviewBatchId: null,
        note: verticals.length > 0 ? '来源测验成果完整' : '来源测次缺垂线测点明细，待确认'
      }
      if (verticals.length === 0) payload.status = '待确认'
    } else {
      // 手工录入：无来源断面，留在待确认，不直接参与定线
      payload = {
        stationId: form.stationId,
        stageM: form.stageM,
        flowM3s: form.flowM3s,
        lineNo: form.lineNo.trim() || 'A',
        measureNo: form.measureNo.trim(),
        measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : now,
        sourceSectionId: null,
        sourceVerticalIds: [],
        sourcePoints: [],
        snapshot: null,
        snapshotStale: false,
        direction: form.direction,
        status: '待确认',
        reviewBatchId: null,
        note: '手工录入，缺来源断面，待确认'
      }
    }

    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('点据已更新（状态与溯源以本次保存为准）')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success(
        payload.status === '待确认'
          ? '点据已登记到待确认，复核后才参与定线'
          : '点据已落档，可在复核中纳入定线'
      )
    }
    ratingStore.setActiveStation(form.stationId)
    ratingStore.setActiveLine(payload.lineNo)
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除水位 ${rating.stageM.toFixed(2)} m 处的点据将同时删除其比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  ElMessage.success('点据已删除')
}

/** 发起一批复核（纳入当前站线全部待复核 / 待确认点据） */
async function startReview(): Promise<void> {
  if (!activeStationId.value) return
  const batch = await reviewStore.startReview(activeStationId.value, activeLineNo.value)
  if (batch.items.length === 0) {
    ElMessage.info('当前线号没有待复核或待确认的点据')
    return
  }
  ElMessage.success('已发起复核，请按涨水 / 退水两支核对并处理冲突')
}

async function quickSetDirection(rating: Rating, direction: TrendDirection): Promise<void> {
  await ratingStore.setRatingDirection([rating.id], direction)
  ElMessage.success(`点据已标记为${direction}`)
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.directions.length ? { dirs: ratingStore.filter.directions.join(',') } : {}),
      ...(ratingStore.filter.statuses.length ? { st: ratingStore.filter.statuses.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  const query = route.query
  if (typeof query.station === 'string') {
    ratingStore.setActiveStation(query.station)
  } else if (!ratingStore.activeStationId && stationStore.stations[0]) {
    ratingStore.setActiveStation(stationStore.stations[0].id)
  }
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    directions:
      typeof query.dirs === 'string'
        ? (query.dirs.split(',').filter((item) => TREND_DIRECTIONS.includes(item as TrendDirection)) as TrendDirection[])
        : [],
    statuses:
      typeof query.st === 'string'
        ? (query.st
            .split(',')
            .filter((item) => RATING_POINT_STATUSES.includes(item as RatingPointStatus)) as RatingPointStatus[])
        : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : []
  })
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与绳套定线</h2>
        <p class="gb-hint">
          每个测站维护可追溯的涨水 / 退水绳套曲线；点据记住来源测次、垂线、测点与流量快照。测次补录或重测后旧曲线先失效，复核通过再发布新版本。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="activeStationId"
          class="page__station-select"
          placeholder="选择测站"
          @change="handleStationChange"
        >
          <el-option v-for="option in stationOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-select :model-value="activeLineNo" class="page__line-select" @change="handleLineChange">
          <el-option v-for="option in lineOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-button type="warning" plain :icon="WarningFilled" :disabled="pendingCount === 0 || Boolean(openBatch)" @click="startReview">
          发起复核{{ pendingCount > 0 ? `（${pendingCount}）` : '' }}
        </el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增点据</el-button>
      </div>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: ratingStore.allLineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        {
          key: 'directions',
          label: '方向',
          options: TREND_DIRECTIONS.map((direction) => ({ label: direction, value: direction }))
        },
        {
          key: 'statuses',
          label: '状态',
          options: RATING_POINT_STATUSES.map((status) => ({ label: status, value: status }))
        },
        { key: 'verdicts', label: '判定', options: [{ label: '合格', value: '合格' }, { label: '超限', value: '超限' }] }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="gb-stats-row">
      <StatBadge label="当前线点据" :value="scopedRatings.length" suffix="点" icon="DataLine" />
      <StatBadge
        :label="activeCurve ? `已确认曲线 v${activeCurve.version}` : '已确认曲线'"
        :value="activeCurve ? `${activeCurve.risingBranch?.fit.valid ? '涨' : ''}${activeCurve.fallingBranch?.fit.valid ? '退' : ''}` : '—'"
        :suffix="activeCurve ? '两支' : '未定线'"
        tone="info"
        icon="TrendCharts"
      />
      <StatBadge
        label="待复核 / 待确认"
        :value="pendingCount"
        suffix="点"
        :tone="pendingCount > 0 ? 'warning' : 'success'"
        icon="WarningFilled"
      />
      <StatBadge
        label="快照脱节"
        :value="staleCount"
        suffix="点"
        :tone="staleCount > 0 ? 'danger' : 'success'"
        icon="Refresh"
      />
    </div>

    <el-alert
      v-if="activeCurve"
      type="success"
      show-icon
      :closable="false"
      :title="`${activeLineNo} 线当前为 v${activeCurve.version} 已确认曲线，确认时间 ${new Date(activeCurve.confirmedAt).toLocaleString('zh-CN')}（${activeCurve.confirmedBy}）`"
    >
      <template #default>
        <span v-if="activeCurve.risingBranch?.fit.valid">
          涨水支 Q={{ activeCurve.risingBranch.fit.a }}(H-{{ activeCurve.risingBranch.fit.h0 }})^{{ activeCurve.risingBranch.fit.b }}（残差 {{ activeCurve.risingBranch.fit.meanResidualPct }}%）；
        </span>
        <span v-if="activeCurve.fallingBranch?.fit.valid">
          退水支 Q={{ activeCurve.fallingBranch.fit.a }}(H-{{ activeCurve.fallingBranch.fit.h0 }})^{{ activeCurve.fallingBranch.fit.b }}（残差 {{ activeCurve.fallingBranch.fit.meanResidualPct }}%）
        </span>
      </template>
    </el-alert>
    <el-alert
      v-else-if="!openBatch"
      type="info"
      show-icon
      :closable="false"
      title="该测站线号还没有已确认曲线。请先从测次落档点据（涨 / 退方向明确），再发起复核确认定线。"
    />

    <!-- 进行中的复核批次：分支试算、冲突列表、确认 / 回滚 -->
    <ReviewPanel v-if="openBatch" :batch="openBatch" />

    <div class="page__grid">
      <EmptyPanel
        v-if="scopedRatings.length === 0"
        title="该测站线号下还没有关系点据"
        description="可选择来源测次按垂线测点成果自动落档（带来源与流量快照），或手工录入（留待确认）。"
        action-text="新增点据"
        @action="openCreate"
      />

      <el-table v-else :data="pointRows" border stripe class="gb-table-compact">
        <el-table-column label="状态" width="92">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.rating.status)" size="small">{{ row.rating.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="方向" width="84">
          <template #default="{ row }">
            <el-dropdown
              trigger="click"
              @command="(value: TrendDirection) => quickSetDirection(row.rating, value)"
            >
              <el-button
                text
                size="small"
                :type="row.rating.direction === '不明' ? 'warning' : row.rating.direction === '涨水' ? 'danger' : 'primary'"
              >
                {{ row.rating.direction }}
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="direction in TREND_DIRECTIONS" :key="direction" :command="direction">
                    {{ direction }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono" :class="{ 'page__stale': row.rating.snapshotStale }">{{ row.rating.flowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差" width="180">
          <template #default="{ row }">
            <DeviationTag
              v-if="row.predicted > 0"
              :deviation-pct="row.residualPct"
              :verdict="row.verdict"
              :limit="ratingStore.deviationLimitPct"
            />
            <span v-else class="gb-hint">未参与定线</span>
          </template>
        </el-table-column>
        <el-table-column label="来源 / 快照" min-width="130">
          <template #default="{ row }">
            <ProvenanceTag :rating="row.rating" :section-measure-no="row.sectionMeasureNo" />
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="120">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.rating.measuredAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openEdit(row.rating)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)" />
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ activeLineNo }} 线绳套曲线（v{{ activeCurve?.version ?? '—' }}）</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <!-- 涨水支红、退水支蓝，同一水位两支差异即绳套 -->
          <polyline v-if="chart.rising" :points="chart.rising" fill="none" stroke="#c0392b" stroke-width="2" />
          <polyline v-if="chart.falling" :points="chart.falling" fill="none" stroke="#0f4c75" stroke-width="2" />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="
              !point.usable
                ? '#c9c9c9'
                : point.verdict === '超限'
                  ? '#c0392b'
                  : point.direction === '涨水'
                    ? '#e8a09a'
                    : '#7fd1e8'
            "
            :stroke="point.direction === '涨水' ? '#7b241c' : '#0f4c75'"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="从测次落档或手工录入点据后生成绳套曲线。" compact />
        <p class="gb-hint">
          红圈/红线为涨水支，蓝圈/蓝线为退水支；灰点为待确认 / 待复核，不参与定线；实心红点为残差超限。
        </p>
      </el-card>
    </div>

    <!-- 历史版本链（可追溯） -->
    <el-card v-if="activeStationId" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>{{ activeLineNo }} 线定线版本留痕</h3>
        <span class="gb-hint">旧版本复核取代后不覆盖删除，保留参数、确认人与失效原因</span>
      </div>
      <el-table
        :data="reviewStore.curveHistory(activeStationId, activeLineNo)"
        border
        size="small"
        class="gb-table-compact"
      >
        <el-table-column prop="version" label="版本" width="80" align="center">
          <template #default="{ row }">v{{ row.version }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === '已确认' ? 'success' : 'info'" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="涨水支" min-width="200">
          <template #default="{ row }">
            <span v-if="row.risingBranch?.fit.valid" class="gb-mono">
              a={{ row.risingBranch.fit.a }} b={{ row.risingBranch.fit.b }} H0={{ row.risingBranch.fit.h0 }}（{{ row.risingBranch.fit.sampleCount }} 点）
            </span>
            <span v-else class="gb-hint">不足定线</span>
          </template>
        </el-table-column>
        <el-table-column label="退水支" min-width="200">
          <template #default="{ row }">
            <span v-if="row.fallingBranch?.fit.valid" class="gb-mono">
              a={{ row.fallingBranch.fit.a }} b={{ row.fallingBranch.fit.b }} H0={{ row.fallingBranch.fit.h0 }}（{{ row.fallingBranch.fit.sampleCount }} 点）
            </span>
            <span v-else class="gb-hint">不足定线</span>
          </template>
        </el-table-column>
        <el-table-column label="确认人 / 时间" min-width="180">
          <template #default="{ row }">
            <div>{{ row.confirmedBy }}</div>
            <div class="gb-hint gb-mono">{{ new Date(row.confirmedAt).toLocaleString('zh-CN') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="失效原因 / 替代" min-width="180">
          <template #default="{ row }">
            <div v-if="row.status === '已失效'" class="page__stale">
              {{ row.invalidateReason || '已被复核取代' }}
            </div>
            <span v-else class="gb-hint">当前生效</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑关系点据' : '新增关系点据'" width="600px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full" :disabled="Boolean(editingId)">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="洪水方向" required>
          <el-radio-group v-model="form.direction">
            <el-radio-button v-for="direction in TREND_DIRECTIONS" :key="direction" :value="direction">
              {{ direction }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="来源测次">
          <el-select
            v-model="form.sourceSectionId"
            placeholder="选择测次则自动拍流量快照；留空为手工录入（待确认）"
            clearable
            filterable
            class="page__full"
            @change="handleSourceSectionChange"
          >
            <el-option v-for="section in sourceSectionOptions" :key="section.id" :label="section.label" :value="section.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="流量" required>
          <el-input-number v-model="form.flowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item v-if="!form.sourceSectionId" label="测次号">
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="点据时间">
          <el-date-picker v-model="form.measuredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
        <el-alert
          :type="form.sourceSectionId ? 'info' : 'warning'"
          :closable="false"
          show-icon
          :title="
            form.sourceSectionId
              ? '从来源测次落档：将记录来源断面、垂线、测点与流量快照；方向不明时留在待确认。'
              : '手工录入无来源，点据将留在待确认，不直接参与定线；补齐来源并复核后才生效。'
          "
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存' : '落档' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__station-select {
  width: 170px;
}

.page__line-select {
  width: 100px;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(560px, 1.55fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 240px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

.page__stale {
  color: #c0392b;
  font-weight: 600;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
