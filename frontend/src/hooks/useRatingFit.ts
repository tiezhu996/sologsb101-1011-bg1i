/**
 * useRatingFit：可追溯绳套曲线的只读派生。
 * 被关系点据页与导出页消费；曲线版本与复核工作流来自 reviewStore（IndexedDB 实时订阅）。
 * 这里不做任何重算落库，只读取「当前已确认曲线」的涨 / 退两支参数并派生残差与绘图采样。
 */
import { computed, type ComputedRef } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import { useReviewStore } from '@/stores/reviewStore'
import type { Compare } from '@/types/compare'
import { curveFlow, type Rating, type RatingFitResult } from '@/types/rating'
import type { CurveBranch } from '@/types/curve'

/** 曲线采样点（用于关系曲线绘制） */
export interface CurveSample {
  stageM: number
  flowM3s: number
}

/** 带残差的点据行 */
export interface RatingPointRow {
  rating: Rating
  stationName: string
  /** 该点据所属分支（涨水 / 退水） */
  branch: Rating['direction']
  /** 曲线流量 */
  curveFlowM3s: number
  /** 相对残差（%）：(实测 - 曲线) / 实测 × 100 */
  residualPct: number
  /** 该点据所属分支的拟合结果（无有效曲线时为 null） */
  fit: RatingFitResult | null
}

export interface UseRatingFitResult {
  /** 当前站线已确认曲线版本号（无曲线为 null） */
  activeVersion: ComputedRef<number | null>
  /** 涨水支拟合（无有效支为 null） */
  risingFit: ComputedRef<RatingFitResult | null>
  /** 退水支拟合 */
  fallingFit: ComputedRef<RatingFitResult | null>
  /** 当前站线点据（含残差与分支） */
  pointRows: ComputedRef<RatingPointRow[]>
  /** 涨水支曲线采样 */
  risingSamples: ComputedRef<CurveSample[]>
  /** 退水支曲线采样 */
  fallingSamples: ComputedRef<CurveSample[]>
  /** 超限点据清单 */
  overLimitRows: ComputedRef<RatingPointRow[]>
  /** 超限点据对应的比测记录 */
  overLimitCompares: ComputedRef<Compare[]>
}

/** 依据点据水位范围对一支有效曲线均匀采样 13 个点 */
function samplesFor(
  branch: CurveBranch | null,
  rows: RatingPointRow[]
): CurveSample[] {
  if (!branch?.fit.valid) return []
  const branchRows = rows.filter((row) => row.rating.direction === branch.direction)
  const stages = branchRows.map((row) => row.rating.stageM)
  if (stages.length === 0) return []
  const min = Math.min(...stages)
  const max = Math.max(...stages)
  const step = (max - min) / 12 || 0.1
  return Array.from({ length: 13 }, (_, index) => {
    const stageM = Number((min + step * index).toFixed(2))
    return { stageM, flowM3s: curveFlow(branch.fit, stageM) }
  })
}

/**
 * 组合式函数：读取当前选中站线的已确认绳套曲线，给出逐点残差与两支绘图采样。
 */
export function useRatingFit(): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const reviewStore = useReviewStore()
  const { activeStationId, activeLineNo, deviationLimitPct } = storeToRefs(ratingStore)

  const curve = computed(() =>
    activeStationId.value
      ? reviewStore.activeCurve(activeStationId.value, activeLineNo.value)
      : null
  )

  const activeVersion = computed(() => curve.value?.version ?? null)
  const risingFit = computed(() => curve.value?.risingBranch?.fit ?? null)
  const fallingFit = computed(() => curve.value?.fallingBranch?.fit ?? null)

  const pointRows = computed<RatingPointRow[]>(() =>
    ratingStore.scopedRatings
      .slice()
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const branch: CurveBranch | null =
          rating.direction === '涨水'
            ? curve.value?.risingBranch ?? null
            : rating.direction === '退水'
              ? curve.value?.fallingBranch ?? null
              : null
        const canPredict = curve.value?.status === '已确认' && rating.status === '已确认' && branch?.fit.valid
        const predicted = canPredict && branch ? curveFlow(branch.fit, rating.stageM) : 0
        const residualPct =
          predicted > 0 && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return {
          rating,
          stationName: ratingStore.stationNameOf(rating.stationId),
          branch: rating.direction,
          curveFlowM3s: predicted,
          residualPct,
          fit: branch?.fit ?? null
        }
      })
  )

  const risingSamples = computed(() => samplesFor(curve.value?.risingBranch ?? null, pointRows.value))
  const fallingSamples = computed(() => samplesFor(curve.value?.fallingBranch ?? null, pointRows.value))

  const overLimitRows = computed<RatingPointRow[]>(() =>
    pointRows.value.filter((row) => Math.abs(row.residualPct) > deviationLimitPct.value)
  )

  const overLimitCompares = computed<Compare[]>(() =>
    reviewStore.compares.filter((compare) => compare.verdict === '超限')
  )

  return {
    activeVersion,
    risingFit,
    fallingFit,
    pointRows,
    risingSamples,
    fallingSamples,
    overLimitRows,
    overLimitCompares
  }
}
