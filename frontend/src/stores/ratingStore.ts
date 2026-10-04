/**
 * 定线 store：维护水位流量关系点据、比测记录、当前站线选择与筛选。
 * 可追溯绳套定线的复核工作流（曲线版本、试算、确认 / 回滚）在 reviewStore；
 * 本 store 只做点据的增删改与基于已确认曲线的只读派生。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, type CompareRow } from '@/types/compare'
import type { Rating, RatingFilterState, TrendDirection, RatingPointStatus } from '@/types/rating'
import { createEmptyRatingFilter, curveFlow } from '@/types/rating'
import type { Station } from '@/types/station'
import type { RatingCurve } from '@/types/curve'
import { curveBranchFor } from '@/utils/curveOps'

/** 新建手工点据的入参（溯源字段可缺省，缺省即待确认） */
export type RatingDraft = Omit<Rating, 'id' | 'createdAt' | 'updatedAt'>

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const stations = ref<Station[]>([])
  const curves = ref<RatingCurve[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前选中测站（绳套按测站维护）与定线号 */
  const activeStationId = ref<string>('')
  const activeLineNo = ref<string>('A')
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
      error.value = null
      if (!activeStationId.value && rows.length > 0) {
        activeStationId.value = rows[0].stationId
      }
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
      if (!activeStationId.value && rows.length > 0) activeStationId.value = rows[0].id
    })
    watchTable<RatingCurve>(() => db.ratingCurves).subscribe((rows) => {
      curves.value = rows
    })
  }

  /** 当前测站可选的定线号（含该站已有定线与待确认点据的线号） */
  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value
      .filter((rating) => rating.stationId === activeStationId.value)
      .forEach((rating) => set.add(rating.lineNo))
    if (set.size === 0) set.add(activeLineNo.value || 'A')
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  /** 全部出现过的定线号（筛选下拉用） */
  const allLineNos = computed<string[]>(() => {
    const set = new Set<string>(ratings.value.map((rating) => rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 当前测站 × 定线号已确认曲线 */
  const activeCurve = computed<RatingCurve | null>(() => {
    if (!activeStationId.value) return null
    return (
      curves.value.find(
        (curve) =>
          curve.stationId === activeStationId.value &&
          curve.lineNo === activeLineNo.value &&
          curve.status === '已确认'
      ) ?? null
    )
  })

  /** 当前站线点据（全状态，按水位排序），表格展示用 */
  const scopedRatings = computed<Rating[]>(() =>
    ratings.value
      .filter((rating) => rating.stationId === activeStationId.value && rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
  )

  /** 点据 + 当前已确认曲线推得的曲线流量 + 残差（未确认曲线或方向不明不推流） */
  const pointRows = computed(() =>
    scopedRatings.value.map((rating) => {
      const curve = activeCurve.value
      const branch = curve ? curveBranchFor(curve, rating.direction) : null
      const predicted =
        curve && rating.status === '已确认' && branch?.fit.valid
          ? curveFlow(branch.fit, rating.stageM)
          : 0
      const residualPct =
        predicted > 0 && rating.flowM3s > 0
          ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
          : 0
      return { rating, predicted, residualPct }
    })
  )

  /** 按筛选条件过滤后的点据（跨站线，供总表 / 导出） */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.directions.length > 0 && !filter.value.directions.includes(rating.direction)) return false
      if (filter.value.statuses.length > 0 && !filter.value.statuses.includes(rating.status)) return false
      if (filter.value.verdicts.length > 0) {
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        if (!compare || !filter.value.verdicts.includes(compare.verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.directions.length > 0 ||
      filter.value.statuses.length > 0 ||
      filter.value.verdicts.length > 0
  )

  /** 比测行：比测记录 + 点据 + 测站名，导出页与分析清单消费 */
  const compareRows = computed<CompareRow[]>(() =>
    compares.value
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        const stationId = rating?.stationId ?? ''
        return {
          compare,
          rating,
          stationId,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? '-'
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 定线质量派生值：已确认曲线数与比测合格占比 */
  const fitQuality = computed(() => {
    const activeCurves = curves.value.filter((curve) => curve.status === '已确认')
    const validCurveCount = activeCurves.length
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    return {
      validCurveCount,
      activeCurveVersion: activeCurve.value?.version ?? null,
      compareCount: total,
      overLimitCount: over,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveStation(stationId: string): void {
    activeStationId.value = stationId
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  /** 新建点据。带来源时带溯源与快照；手工 / 缺来源点据留在待确认，不直接参与定线 */
  async function createRating(payload: RatingDraft): Promise<Rating> {
    const now = Date.now()
    const row: Rating = { ...payload, id: createId('rat'), createdAt: now, updatedAt: now }
    await db.ratings.put(row)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    await db.ratings.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeRating(id: string): Promise<void> {
    await db.transaction('rw', [db.ratings, db.compares], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
    })
  }

  /** 批量设置点据方向（复核页外的快捷整理），方向改不明自动排除留待确认 */
  async function setRatingDirection(ids: string[], direction: TrendDirection): Promise<void> {
    if (ids.length === 0) return
    const now = Date.now()
    await db.ratings
      .where('id')
      .anyOf(ids)
      .modify((rating: Rating) => {
        rating.direction = direction as Rating['direction']
        if (direction === '不明' && rating.status === '已确认') rating.status = '待确认'
        rating.updatedAt = now
      })
  }

  /** 批量设置点据状态（缺来源补登后人工移入待复核等） */
  async function setRatingStatus(ids: string[], status: RatingPointStatus): Promise<void> {
    if (ids.length === 0) return
    const now = Date.now()
    await db.ratings
      .where('id')
      .anyOf(ids)
      .modify((rating: Rating) => {
        rating.status = status
        if (status !== '已确认') rating.reviewBatchId = null
        rating.updatedAt = now
      })
  }

  /** 手工登记比测记录（导出页分析清单用） */
  async function createCompare(
    payload: Omit<Compare, 'id' | 'createdAt' | 'updatedAt' | 'deviationPct' | 'verdict'> & {
      deviationPct?: number
      verdict?: Compare['verdict']
    }
  ): Promise<Compare> {
    const now = Date.now()
    const deviationPct =
      payload.deviationPct ??
      (payload.measuredFlow !== 0
        ? Number((((payload.curveFlow - payload.measuredFlow) / payload.measuredFlow) * 100).toFixed(2))
        : 0)
    const row: Compare = {
      ...payload,
      deviationPct,
      verdict:
        payload.verdict ?? (Math.abs(deviationPct) > deviationLimitPct.value ? '超限' : '合格'),
      id: createId('cmp'),
      createdAt: now,
      updatedAt: now
    }
    await db.compares.put(row)
    return row
  }

  async function removeCompare(id: string): Promise<void> {
    await db.compares.delete(id)
  }

  return {
    ratings,
    compares,
    stations,
    curves,
    ready,
    error,
    filter,
    activeStationId,
    activeLineNo,
    activeCurve,
    deviationLimitPct,
    lineNos,
    allLineNos,
    pointRows,
    scopedRatings,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    stationNameOf,
    patchFilter,
    resetFilter,
    setActiveStation,
    setActiveLine,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    setRatingDirection,
    setRatingStatus,
    createCompare,
    removeCompare
  }
})
