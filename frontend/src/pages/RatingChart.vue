<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与可追溯绳套定线
 * 已确认涨水/退水曲线分开绘制；补录、重测后的点据进入待确认，复核后生成新版本。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, Select, TrendCharts, Warning } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { RATING_STATUS_LABEL, type RatingDirection } from '@/types/ratingDirection'
import type { Rating } from '@/types/rating'
import { calcSectionDischarge } from '@/utils/flow'
import { initDatabase } from '@/utils/db'
import { detectBranchConflicts } from '@/utils/review'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()
const sectionStore = useSectionStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const reviewing = ref(false)
const form = reactive({
  stationId: '',
  sourceSectionId: '',
  sourceVerticalId: '',
  sourcePointId: '',
  lineNo: 'A',
  direction: '涨水' as RatingDirection,
  useSectionFlow: true,
  stageM: 0,
  flowM3s: 0,
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

const activeStation = computed(
  () => stationStore.stations.find((station) => station.id === (ratingStore.activeStationId || stationStore.stations[0]?.id)) ?? null
)
const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))
const sourceSections = computed(() => sectionStore.sectionsOfStation(activeStation.value?.id).filter((section) => section.stationId === activeStation.value?.id))
const sourceVerticals = computed(() => sectionStore.verticalsOfSection(form.sourceSectionId))
const sourcePoints = computed(() => sectionStore.pointsOfVertical(form.sourceVerticalId))

const pointRows = computed(() =>
  ratingStore.ratings
    .filter((rating) => rating.stationId === activeStation.value?.id && rating.lineNo === ratingStore.activeLineNo)
    .sort((a, b) => a.stageM - b.stageM)
    .map((rating) => {
      const curve = ratingStore.curveForRating(rating)
      const predicted = curve?.fit.valid
        ? Number((curve.fit.a * Math.pow(Math.max(rating.stageM - curve.fit.h0, 1e-6), curve.fit.b)).toFixed(2))
        : 0
      const residualPct =
        curve?.fit.valid && rating.flowM3s > 0
          ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
          : 0
      const compare = ratingStore.latestCompareForRating(rating.id)
      return {
        rating,
        stationName: ratingStore.stationNameOf(rating.stationId),
        curve,
        predicted,
        residualPct,
        verdict: compare?.verdict ?? (Math.abs(residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格')
      }
    })
)
const pendingRows = computed(() => pointRows.value.filter((row) => row.rating.status !== 'confirmed'))
const currentCurves = computed(() => ratingStore.confirmedCurves(activeStation.value?.id ?? '', ratingStore.activeLineNo))
const currentConflicts = computed(() => {
  const rows = pointRows.value.map((row) => row.rating)
  const crossed = detectBranchConflicts(rows, ratingStore.activeLineNo)
  const missing = rows
    .filter((rating) => rating.status !== 'confirmed')
    .flatMap((rating) => {
      const issues: Array<{ rating: Rating; message: string }> = []
      if (rating.direction === '未知') issues.push({ rating, message: '方向不明' })
      if (!rating.sourceRef?.sectionId || !rating.sourceSnapshot?.section) issues.push({ rating, message: '缺来源断面或流量快照' })
      if (rating.status === 'stale') issues.push({ rating, message: rating.staleReason || '原始测次已更新' })
      return issues
    })
  return [...crossed, ...missing.map((item) => ({
    stationId: item.rating.stationId,
    lineNo: ratingStore.activeLineNo,
    branch: item.rating.direction,
    rating: item.rating,
    message: item.message,
    severity: 'missing' as const
  }))]
})

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts
}))

function branchColor(branch?: RatingDirection | string): string {
  return branch === '退水' ? '#d9822b' : '#0f4c75'
}

const chart = computed(() => {
  const rows = pointRows.value.filter((row) => row.rating.status === 'confirmed')
  if (rows.length === 0) {
    return { polylines: [], points: [] as Array<{ id: string; cx: number; cy: number; verdict: string; branch: string }>, stageMin: 0, stageMax: 0, flowMax: 1 }
  }
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
  const polylines = currentCurves.value.map((curve) => {
    const ids = new Set(curve.ratingIds)
    const curveRows = rows.filter((row) => ids.has(row.rating.id))
    const curveStages = curveRows.map((row) => row.rating.stageM)
    const min = Math.min(...curveStages)
    const max = Math.max(...curveStages)
    const step = (max - min) / 12 || 0.1
    const samples = Array.from({ length: 13 }, (_, index) => {
      const stageM = Number((min + step * index).toFixed(2))
      const value = curve.fit.a * Math.pow(Math.max(stageM - curve.fit.h0, 1e-6), curve.fit.b)
      return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
    }).join(' ')
    return { id: curve.id, branch: curve.branch, color: branchColor(curve.branch), samples }
  })
  return {
    polylines,
    points: rows.map((row) => ({
      id: row.rating.id,
      cx: toX(row.rating.stageM),
      cy: toY(row.rating.flowM3s),
      verdict: row.verdict,
      branch: row.rating.direction
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

function syncSourceSnapshot(): void {
  const section = sectionStore.sectionById(form.sourceSectionId)
  if (!section) return
  const verticals = form.sourceVerticalId
    ? sectionStore.verticalsOfSection(section.id).filter((vertical) => vertical.id === form.sourceVerticalId)
    : sectionStore.verticalsOfSection(section.id)
  const slices = verticals.map((vertical) => {
    const rowPoints = sectionStore.pointsOfVertical(vertical.id)
    const totalWeight = rowPoints.reduce((sum, point) => sum + Math.max(point.weight, 0), 0)
    const meanVelocityMs = totalWeight > 0
      ? rowPoints.reduce((sum, point) => sum + point.velocityMs * point.weight, 0) / totalWeight
      : rowPoints.reduce((sum, point) => sum + point.velocityMs, 0) / Math.max(rowPoints.length, 1)
    return {
      id: vertical.id,
      no: vertical.no,
      startDistanceM: vertical.startDistanceM,
      depthM: vertical.depthM,
      meanVelocityMs: Number(meanVelocityMs.toFixed(3))
    }
  })
  const discharge = calcSectionDischarge(slices)
  form.measureNo = section.measureNo
  form.measuredAt = section.measuredAt.slice(0, 16)
  form.stageM = section.stageM
  form.flowM3s = discharge.flowM3s
}

function openCreate(): void {
  editingId.value = null
  form.stationId = activeStation.value?.id ?? stationStore.stations[0]?.id ?? ''
  ratingStore.setActiveStation(form.stationId)
  form.lineNo = ratingStore.activeLineNo
  form.direction = '涨水'
  form.sourceSectionId = sectionStore.sectionsOfStation(form.stationId)[0]?.id ?? ''
  form.sourceVerticalId = ''
  form.sourcePointId = ''
  form.useSectionFlow = true
  syncSourceSnapshot()
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.sourceSectionId = rating.sourceRef?.sectionId ?? ''
  form.sourceVerticalId = rating.sourceRef?.verticalId ?? ''
  form.sourcePointId = rating.sourceRef?.pointId ?? ''
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.direction = rating.direction
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!activeStation.value) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!form.sourceSectionId) {
    ElMessage.warning('请选择来源断面；缺来源的点据只能停留在待确认')
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, {
        lineNo: form.lineNo.trim() || 'A',
        direction: form.direction,
        measureNo: form.measureNo.trim(),
        measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString(),
        stageM: form.stageM,
        flowM3s: form.flowM3s
      })
      ElMessage.success('点据修订已进入待确认，旧曲线未覆盖')
    } else {
      await ratingStore.createRatingFromSection(form.sourceSectionId, {
        lineNo: form.lineNo.trim() || 'A',
        direction: form.direction,
        verticalId: form.sourceVerticalId || undefined,
        pointId: form.sourcePointId || undefined,
        flowM3s: form.useSectionFlow ? undefined : form.flowM3s
      })
      ElMessage.success('点据已带来源快照进入待确认')
    }
    ratingStore.setActiveStation(activeStation.value.id)
    ratingStore.setActiveLine(form.lineNo.trim() || 'A')
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm('删除点据不会删除已确认历史曲线与历史比测结果，确认删除？', '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  ElMessage.success('点据已删除，已确认曲线保留')
}

async function reviewLine(): Promise<void> {
  if (!activeStation.value) return
  reviewing.value = true
  try {
    const result = await ratingStore.reviewActiveLine()
    if (result.batch.status !== 'success') {
      const first = [...result.conflicts.map((item) => item.message), ...result.batch.errors].slice(0, 3).join('；')
      ElMessage.warning(`复核失败，已恢复到上次确认测次：${first || '存在冲突'}；已确认曲线和比测保留`)
      return
    }
    ElMessage.success(`复核确认：生成 ${result.curves.filter((curve) => curve.reviewBatchId === result.batch.id).length} 条分支曲线，比测结果已追加保留`)
  } finally {
    reviewing.value = false
  }
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
}

function handleStationChange(stationId: string | number | boolean | undefined): void {
  const id = String(stationId)
  ratingStore.setActiveStation(id)
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

function statusType(status: Rating['status']): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'confirmed') return 'success'
  if (status === 'stale') return 'danger'
  return 'warning'
}

function statusLabel(status: Rating['status']): string {
  return RATING_STATUS_LABEL[status]
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  const query = route.query
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
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
          每个点据固化来源断面、垂线、测点和流量快照；复核时按涨水、退水分支拟合，原始测次更新后旧定线先失效。
        </p>
      </div>
      <div class="page__actions">
        <el-select :model-value="activeStation?.id" class="page__station-select" @change="handleStationChange">
          <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
        </el-select>
        <el-select :model-value="ratingStore.activeLineNo" class="page__line-select" @change="handleLineChange">
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button type="warning" :icon="Select" :loading="reviewing" @click="reviewLine">复核并重算</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增点据</el-button>
      </div>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        { key: 'stationIds', label: '测站', options: stationStore.stations.map((station) => ({ label: station.name, value: station.id })) },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        { key: 'verdicts', label: '判定', options: [{ label: '合格', value: '合格' }, { label: '超限', value: '超限' }] }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 水势 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="gb-stats-row">
      <StatBadge label="已确认点据" :value="pointRows.filter((row) => row.rating.status === 'confirmed').length" suffix="点" icon="DataLine" tone="success" />
      <StatBadge label="待确认/失效" :value="pendingRows.length" suffix="点" :tone="pendingRows.length ? 'danger' : 'success'" icon="WarningFilled" />
      <StatBadge label="绳套分支" :value="currentCurves.length" suffix="条" icon="TrendCharts" tone="info" />
      <StatBadge label="平均残差" :value="currentCurves[0]?.fit.meanResidualPct ?? '—'" suffix="%" icon="Histogram" />
    </div>

    <el-alert
      v-if="pendingRows.length > 0"
      type="warning"
      show-icon
      :closable="false"
      title="存在待确认点据：缺来源或方向不明不会参与正式定线；水位重叠且涨退水交叉的测次会先列冲突，复核失败自动恢复到上次确认状态。"
    />
    <el-alert
      v-else
      type="success"
      show-icon
      :closable="false"
      :title="currentCurves.length ? `当前已确认 ${currentCurves.map((curve) => curve.branch).join('、')} 曲线，历史比测结果按版本保留` : '暂无已确认曲线，请新增带来源的点据后复核'"
    />

    <el-card v-if="currentConflicts.length > 0" shadow="never" class="page__conflict-card">
      <div class="gb-panel-title">
        <h3><el-icon><Warning /></el-icon> 复核前冲突（优先处理）</h3>
        <el-tag type="danger" effect="plain">{{ currentConflicts.length }} 项</el-tag>
      </div>
      <ul class="page__conflict-list">
        <li v-for="(conflict, index) in currentConflicts.slice(0, 6)" :key="`${conflict.rating.id}-${index}`">
          <el-tag size="small" :type="conflict.severity === 'conflict' ? 'danger' : 'warning'">
            {{ conflict.severity === 'conflict' ? '分支交叉' : '待补录' }}
          </el-tag>
          <span class="gb-mono">{{ conflict.rating.measureNo || '缺测次' }} · {{ conflict.branch }} · H={{ conflict.rating.stageM.toFixed(2) }}</span>
          <span>{{ conflict.message }}</span>
        </li>
      </ul>
    </el-card>

    <div class="page__grid">
      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ ratingStore.activeLineNo }} 线涨水/退水绳套</h3>
          <div>
            <el-tag v-for="curve in currentCurves" :key="curve.id" :color="branchColor(curve.branch)" effect="dark" size="small" class="page__branch-tag">
              {{ curve.branch }} v{{ curve.version }}
            </el-tag>
          </div>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <polyline
            v-for="line in chart.polylines"
            :key="line.id"
            :points="line.samples"
            fill="none"
            :stroke="line.color"
            stroke-width="2"
          />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="point.verdict === '超限' ? '#c0392b' : branchColor(point.branch)"
            stroke="#ffffff"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="新增带来源断面、垂线、测点快照的点据后复核生成绳套。" compact />
        <p class="gb-hint">蓝线为涨水分支，橙线为退水分支；待确认和失效点不覆盖正式曲线。</p>
      </el-card>

      <el-table :data="pointRows" border stripe class="gb-table-compact">
        <el-table-column label="状态" width="116">
          <template #default="{ row }">
            <el-tag :type="statusType(row.rating.status)" size="small">{{ statusLabel(row.rating.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="方向" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.rating.direction === '退水' ? 'warning' : row.rating.direction === '涨水' ? 'success' : 'info'">
              {{ row.rating.direction }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="水位" width="90" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span></template>
        </el-table-column>
        <el-table-column label="流量" width="90" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span></template>
        </el-table-column>
        <el-table-column label="曲线/残差" min-width="170">
          <template #default="{ row }">
            <DeviationTag :deviation-pct="row.residualPct" :verdict="row.verdict" :limit="ratingStore.deviationLimitPct" />
            <div class="gb-hint">{{ row.curve ? `${row.curve.branch} v${row.curve.version}` : '待复核' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="来源追溯" min-width="230">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.rating.measureNo || '缺测次来源' }}</div>
            <div class="gb-hint">
              断面 {{ row.rating.sourceSnapshot?.verticals.length ?? 0 }} 垂线 / {{ row.rating.sourceSnapshot?.points.length ?? 0 }} 测点
              <el-icon v-if="row.rating.status !== 'confirmed'"><Warning /></el-icon>
            </div>
            <div v-if="row.rating.staleReason" class="page__danger">{{ row.rating.staleReason }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.rating)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑关系点据（进入待确认）' : '新增带来源的关系点据'" width="680px" :close-on-click-modal="false">
      <el-form label-width="120px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" :disabled="Boolean(editingId)" class="page__full" @change="ratingStore.setActiveStation(form.stationId)">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源断面" required>
          <el-select v-model="form.sourceSectionId" class="page__full" :disabled="Boolean(editingId)" @change="syncSourceSnapshot">
            <el-option v-for="section in sourceSections" :key="section.id" :label="`${section.measureNo} · ${section.stageM.toFixed(2)}m · ${section.trend}`" :value="section.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="!editingId" label="来源垂线">
          <el-select v-model="form.sourceVerticalId" class="page__full" clearable placeholder="默认整个断面全部垂线" @change="form.sourcePointId = ''">
            <el-option v-for="vertical in sourceVerticals" :key="vertical.id" :label="`${vertical.no} 号垂线 · ${vertical.startDistanceM}m`" :value="vertical.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="!editingId && form.sourceVerticalId" label="代表测点">
          <el-select v-model="form.sourcePointId" class="page__full" clearable placeholder="默认为该垂线全部测点">
            <el-option v-for="point in sourcePoints" :key="point.id" :label="`相对水深 ${point.relativeDepth} · ${point.velocityMs}m/s`" :value="point.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required><el-input v-model="form.lineNo" maxlength="8" /></el-form-item>
        <el-form-item label="水势方向" required>
          <el-radio-group v-model="form.direction">
            <el-radio-button value="涨水">涨水</el-radio-button>
            <el-radio-button value="退水">退水</el-radio-button>
            <el-radio-button value="未知">方向不明</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="水位"><el-input-number v-model="form.stageM" :precision="2" :step="0.01" controls-position="right" /><span class="page__unit">m</span></el-form-item>
        <el-form-item label="流量快照">
          <el-input-number v-model="form.flowM3s" :precision="1" :step="1" :disabled="!editingId && form.useSectionFlow" controls-position="right" />
          <el-checkbox v-if="!editingId" v-model="form.useSectionFlow" class="page__unit">使用断面流量快照</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :icon="Refresh" @click="submitForm">
          {{ editingId ? '保存为待确认' : '保存来源快照' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 14px; }
.page__head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; }
.page__title { margin: 0 0 4px; font-size: 19px; color: #0f4c75; }
.page__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.page__station-select { width: 170px; }
.page__line-select { width: 110px; }
.page__grid { display: grid; grid-template-columns: minmax(360px, 0.9fr) minmax(560px, 1.4fr); gap: 14px; align-items: start; }
.page__chart-card { border: 1px solid #d8e4ec; }
.page__chart { width: 100%; height: 260px; }
.page__branch-tag { margin-left: 6px; color: #fff; }
.page__unit { margin-left: 8px; font-size: 12px; color: #8194a2; }
.page__full { width: 100%; }
.page__danger { color: #c0392b; font-size: 12px; }
.page__conflict-card { border-color: #e6b7a0; }
.page__conflict-list { margin: 8px 0 0; padding-left: 0; list-style: none; display: grid; gap: 6px; }
.page__conflict-list li { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; }
@media (max-width: 1180px) { .page__grid { grid-template-columns: 1fr; } }
</style>
