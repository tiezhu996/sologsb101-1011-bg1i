/**
 * useRatingFit：读取已确认绳套曲线、逐点残差与曲线采样。
 * 待确认 / stale 点据不会被临时拟合，必须经复核写入 ratingCurves 后才成为正式曲线。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import type { Compare } from '@/types/compare'
import type { RatingDirection } from '@/types/ratingDirection'
import { curveFlow, type Rating, type RatingFitResult } from '@/types/rating'

export interface CurveSample {
  stageM: number
  flowM3s: number
}

export interface RatingPointRow {
  rating: Rating
  stationName: string
  branch: RatingDirection
  curveFlowM3s: number
  residualPct: number
  fit: RatingFitResult | null
}

export interface UseRatingFitResult {
  ratings: Ref<Rating[]>
  compares: Ref<Compare[]>
  lineNos: ComputedRef<string[]>
  activeLineNo: Ref<string>
  fit: ComputedRef<RatingFitResult>
  allFits: ComputedRef<RatingFitResult[]>
  pointRows: ComputedRef<RatingPointRow[]>
  curveSamples: ComputedRef<CurveSample[]>
  overLimitRows: ComputedRef<RatingPointRow[]>
  overLimitCompares: ComputedRef<Compare[]>
  setActiveLine: (lineNo: string) => void
  refit: () => RatingFitResult
}

export function useRatingFit(initialLineNo = 'A'): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const { ratings, compares, ratingCurves } = storeToRefs(ratingStore)
  const activeLineNo = ref<string>(initialLineNo)

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    ratingCurves.value.forEach((curve) => set.add(curve.lineNo))
    if (set.size === 0) set.add(initialLineNo)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const activeCurves = computed(() =>
    ratingCurves.value.filter(
      (curve) =>
        curve.lineNo === activeLineNo.value &&
        curve.stationId === ratingStore.activeStationId &&
        curve.status === 'confirmed'
    )
  )

  const allFits = computed<RatingFitResult[]>(() => activeCurves.value.map((curve) => curve.fit))

  const fit = computed<RatingFitResult>(
    () =>
      allFits.value[0] ?? {
        lineNo: activeLineNo.value,
        branch: '涨水',
        a: 0,
        b: 0,
        h0: 0,
        sampleCount: 0,
        meanResidualPct: 0,
        maxResidualPct: 0,
        r2: 0,
        valid: false,
        message: '尚无已确认绳套曲线'
      }
  )

  const pointRows = computed<RatingPointRow[]>(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value && rating.status === 'confirmed')
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const curve = ratingStore.curveForRating(rating)
        const current = curve?.fit ?? null
        const predicted = current?.valid ? curveFlow(current, rating.stageM) : 0
        const residualPct =
          current?.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return {
          rating,
          stationName: ratingStore.stationNameOf(rating.stationId),
          branch: rating.direction,
          curveFlowM3s: predicted,
          residualPct,
          fit: current
        }
      })
  )

  const curveSamples = computed<CurveSample[]>(() => {
    const current = fit.value
    const rows = pointRows.value
    if (!current.valid || rows.length === 0) return []
    const stages = rows.map((row) => row.rating.stageM)
    const min = Math.min(...stages)
    const max = Math.max(...stages)
    const step = (max - min) / 12 || 0.1
    return Array.from({ length: 13 }, (_, index) => {
      const stageM = Number((min + step * index).toFixed(2))
      return { stageM, flowM3s: curveFlow(current, stageM) }
    })
  })

  const overLimitRows = computed<RatingPointRow[]>(() =>
    pointRows.value.filter((row) => Math.abs(row.residualPct) > ratingStore.deviationLimitPct)
  )

  const overLimitCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.verdict === '超限')
  )

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
    ratingStore.setActiveLine(lineNo)
  }

  function refit(): RatingFitResult {
    // 正式重算必须走复核批次；此处仅返回当前已确认曲线，避免直接覆盖。
    return fit.value
  }

  return {
    ratings,
    compares,
    lineNos,
    activeLineNo,
    fit,
    allFits,
    pointRows,
    curveSamples,
    overLimitRows,
    overLimitCompares,
    setActiveLine,
    refit
  }
}
