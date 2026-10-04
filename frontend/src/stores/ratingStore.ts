/**
 * 定线 store：维护关系点据、可追溯绳套曲线、复核批次与比测结果。
 * 已确认曲线不被点据编辑直接覆盖；原始测次变化后点据置 stale，经复核生成新版本。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import type { Rating, RatingFitResult } from '@/types/rating'
import type { RatingCurve } from '@/types/ratingCurve'
import type { ReviewBatch, StationReviewResult } from '@/types/review'
import { createEmptyRatingFilter, type RatingFilterState } from '@/types/rating'
import { reviewStationLine } from '@/utils/review'
import { buildRatingSourceSnapshot } from '@/utils/ratingSource'
import type { Station } from '@/types/station'

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const ratingCurves = ref<RatingCurve[]>([])
  const reviewBatches = ref<ReviewBatch[]>([])
  const compares = ref<Compare[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  const activeStationId = ref<string>('')
  const activeLineNo = ref<string>('A')
  const fits = ref<RatingFitResult[]>([])
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<RatingCurve>(() => db.ratingCurves).subscribe((rows) => {
      ratingCurves.value = rows
    })
    watchTable<ReviewBatch>(() => db.reviewBatches).subscribe((rows) => {
      reviewBatches.value = rows
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
      if (!activeStationId.value) activeStationId.value = rows[0]?.id ?? ''
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    ratingCurves.value.forEach((curve) => set.add(curve.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  const activeStation = computed<Station | null>(
    () => stations.value.find((station) => station.id === activeStationId.value) ?? null
  )

  function confirmedCurves(stationId = activeStationId.value, lineNo = activeLineNo.value): RatingCurve[] {
    return ratingCurves.value
      .filter((curve) => curve.stationId === stationId && curve.lineNo === lineNo && curve.status === 'confirmed')
      .sort((a, b) => (a.branch.localeCompare(b.branch) || b.version - a.version))
  }

  function curveForRating(rating: Rating): RatingCurve | null {
    const direct = ratingCurves.value.find((curve) => curve.id === rating.confirmedCurveId && curve.status === 'confirmed')
    if (direct) return direct
    return (
      confirmedCurves(rating.stationId, rating.lineNo).find((curve) => curve.branch === rating.direction) ?? null
    )
  }

  /** 当前测站/定线号下的已确认涨水、退水拟合结果 */
  const allFits = computed<RatingFitResult[]>(() =>
    confirmedCurves().map((curve) => ({ ...curve.fit, lineNo: curve.lineNo, branch: curve.branch }))
  )

  const activeFit = computed<RatingFitResult>(() => allFits.value[0] ?? fitPlaceholder(activeLineNo.value))

  function fitPlaceholder(lineNo: string, branch: Rating['direction'] = '涨水'): RatingFitResult {
    return {
      lineNo,
      branch,
      a: 0,
      b: 0,
      h0: 0,
      sampleCount: 0,
      meanResidualPct: 0,
      maxResidualPct: 0,
      r2: 0,
      valid: false,
      message: '尚无已确认绳套曲线；请在待确认点据复核通过后查看'
    }
  }

  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.stationId === activeStationId.value && rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const curve = curveForRating(rating)
        const predicted = curve?.fit.valid ? curveFlowValue(curve.fit, rating.stageM) : 0
        const residualPct =
          curve?.fit.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return { rating, curve, predicted, residualPct }
      })
  )

  const pendingRows = computed(() =>
    pointRows.value.filter((row) => row.rating.status !== 'confirmed')
  )

  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${rating.direction}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.verdicts.length > 0) {
        const compare = latestCompareForRating(rating.id)
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
      filter.value.verdicts.length > 0
  )

  function latestCompareForRating(ratingId: string): Compare | null {
    const rows = compares.value.filter((compare) => compare.ratingId === ratingId)
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  }

  const compareRows = computed<CompareRow[]>(() => {
    const latest = new Map<string, Compare>()
    compares.value.forEach((compare) => {
      const current = latest.get(compare.ratingId)
      if (!current || compare.updatedAt > current.updatedAt) latest.set(compare.ratingId, compare)
    })
    return Array.from(latest.values())
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: compare.lineNo || rating?.lineNo || '-'
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  })

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  const fitQuality = computed(() => {
    const validCurves = ratingCurves.value.filter((curve) => curve.status === 'confirmed' && curve.fit.valid)
    const meanResidual = validCurves.length
      ? Number((validCurves.reduce((sum, curve) => sum + curve.fit.meanResidualPct, 0) / validCurves.length).toFixed(2))
      : 0
    const total = compareRows.value.length
    const over = compareRows.value.filter((row) => row.compare.verdict === '超限').length
    return {
      validLineCount: validCurves.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  function curveFlowValue(fit: RatingFitResult, stageM: number): number {
    if (!fit.valid) return 0
    return Number((fit.a * Math.pow(Math.max(stageM - fit.h0, 1e-6), fit.b)).toFixed(2))
  }

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setActiveStation(stationId: string): void {
    activeStationId.value = stationId
  }

  function setFit(fit: RatingFitResult): void {
    const others = fits.value.filter(
      (item) => !(item.lineNo === fit.lineNo && item.branch === fit.branch)
    )
    fits.value = [...others, fit]
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  async function createRatingFromSection(sectionId: string, payload: {
    lineNo: string
    direction: Rating['direction']
    verticalId?: string
    pointId?: string
    flowM3s?: number
  }): Promise<Rating> {
    const section = await db.sections.get(sectionId)
    if (!section) throw new Error('来源断面不存在')
    const verticals = await db.verticals.where('sectionId').equals(sectionId).toArray()
    const selectedVerticals = payload.verticalId
      ? verticals.filter((vertical) => vertical.id === payload.verticalId)
      : verticals
    const points = await db.points
      .where('verticalId')
      .anyOf(selectedVerticals.map((vertical) => vertical.id))
      .toArray()
    const snapshot = buildRatingSourceSnapshot(section, selectedVerticals, points)
    const timestamp = Date.now()
    const row: Rating = {
      id: createId('rat'),
      stationId: section.stationId,
      stageM: section.stageM,
      flowM3s: payload.flowM3s ?? snapshot.flow?.flowM3s ?? 0,
      lineNo: payload.lineNo,
      direction: payload.direction === '未知' ? section.trend : payload.direction,
      status: 'pending',
      measureNo: section.measureNo,
      sourceRef: { sectionId, verticalId: payload.verticalId, pointId: payload.pointId },
      sourceSnapshot: snapshot,
      sourceSnapshotAt: timestamp,
      staleReason: '',
      confirmedCurveId: null,
      confirmedAt: null,
      measuredAt: section.measuredAt,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await db.ratings.put(row)
    return row
  }

  async function createRating(payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt'>): Promise<Rating> {
    const now = Date.now()
    const row: Rating = { ...payload, id: createId('rat'), createdAt: now, updatedAt: now }
    await db.ratings.put(row)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    const current = await db.ratings.get(id)
    const nextPatch: Partial<Rating> = { ...patch, updatedAt: Date.now() }
    // 手工改点不覆盖已确认成果：新值先进待确认/失效，复核后才生成新曲线。
    if (current?.status === 'confirmed') {
      const timestamp = Date.now()
      const previousCurveId = current.confirmedCurveId
      nextPatch.status = 'pending'
      nextPatch.confirmedCurveId = null
      nextPatch.confirmedAt = null
      nextPatch.staleReason = '点据被人工修订，等待复核'
      if (previousCurveId) {
        await db.ratingCurves.update(previousCurveId, {
          status: 'invalid',
          reviewNote: '关系点据被人工修订，旧定线失效',
          updatedAt: timestamp
        } as never)
      }
    }
    await db.ratings.update(id, nextPatch as never)
  }

  async function removeRating(id: string): Promise<void> {
    const rating = await db.ratings.get(id)
    await db.transaction('rw', [db.ratings, db.ratingCurves], async () => {
      if (rating?.confirmedCurveId) {
        await db.ratingCurves.update(rating.confirmedCurveId, {
          status: 'invalid',
          reviewNote: '关系点据被删除，旧定线失效',
          updatedAt: Date.now()
        } as never)
      }
      await db.ratings.delete(id)
    })
  }

  async function markRatingsFromSectionStale(sectionId: string, reason: string): Promise<void> {
    const timestamp = Date.now()
    await db.ratings
      .where('status')
      .equals('confirmed')
      .filter((rating) => rating.sourceRef?.sectionId === sectionId)
      .modify((rating) => {
        rating.status = 'stale'
        rating.staleReason = reason
        rating.updatedAt = timestamp
      })
  }

  async function reviewActiveLine(): Promise<StationReviewResult> {
    const [sections, verticals, points] = await Promise.all([
      db.sections.toArray(),
      db.verticals.toArray(),
      db.points.toArray()
    ])
    return reviewStationLine({
      stationId: activeStationId.value,
      lineNo: activeLineNo.value,
      sections,
      verticals,
      points
    })
  }

  /** 兼容旧页面入口：正式比测只由复核产生，这里不再直接覆盖已确认曲线。 */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const targetLine = lineNo ?? activeLineNo.value
    return compares.value.filter((compare) => compare.lineNo === targetLine).length
  }

  async function createCompare(
    payload: Omit<Compare, 'id' | 'createdAt' | 'updatedAt' | 'deviationPct' | 'verdict'> & {
      deviationPct?: number
      verdict?: Compare['verdict']
    }
  ): Promise<Compare> {
    const now = Date.now()
    const deviationPct =
      payload.deviationPct ?? calcDeviationPct(payload.measuredFlow, payload.curveFlow)
    const row: Compare = {
      ...payload,
      deviationPct,
      verdict: payload.verdict ?? judgeDeviation(deviationPct, deviationLimitPct.value),
      id: createId('cmp'),
      createdAt: now,
      updatedAt: now
    }
    await db.compares.put(row)
    return row
  }

  async function updateCompare(id: string, patch: Partial<Compare>): Promise<void> {
    await db.compares.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeCompare(id: string): Promise<void> {
    await db.compares.delete(id)
  }

  return {
    ratings,
    ratingCurves,
    reviewBatches,
    compares,
    stations,
    ready,
    error,
    filter,
    activeStationId,
    activeStation,
    activeLineNo,
    activeFit,
    fits,
    deviationLimitPct,
    lineNos,
    allFits,
    confirmedCurves,
    curveForRating,
    pointRows,
    pendingRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    stationNameOf,
    latestCompareForRating,
    patchFilter,
    resetFilter,
    setActiveLine,
    setActiveStation,
    setFit,
    setDeviationLimit,
    createRatingFromSection,
    createRating,
    updateRating,
    removeRating,
    markRatingsFromSectionStale,
    reviewActiveLine,
    rebuildCompares,
    createCompare,
    updateCompare,
    removeCompare
  }
})
