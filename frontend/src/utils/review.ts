import { createId, db } from '@/utils/db'
import type { Point } from '@/types/point'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import { calcDeviationPct, judgeDeviation, type Compare } from '@/types/compare'
import type { RatingDirection } from '@/types/ratingDirection'
import { curveFlow, fitPowerCurve, type Rating, type RatingFitResult } from '@/types/rating'
import type { RatingCurve } from '@/types/ratingCurve'
import type { RatingSourceSnapshot } from '@/types/ratingSource'
import { buildRatingSourceSnapshot } from '@/utils/ratingSource'
import type { ReviewBatch, ReviewConflict, StationReviewResult } from '@/types/review'

const now = (): number => Date.now()

function scopeRatings(ratings: Rating[], stationId: string, lineNo: string): Rating[] {
  return ratings.filter((rating) => rating.stationId === stationId && rating.lineNo === lineNo)
}

function scopeCurves(curves: RatingCurve[], stationId: string, lineNo: string): RatingCurve[] {
  return curves.filter((curve) => curve.stationId === stationId && curve.lineNo === lineNo)
}

function scopeCompares(
  compares: Compare[],
  scopedRatings: Rating[],
  curves: RatingCurve[]
): Compare[] {
  const ratingIds = new Set(scopedRatings.map((rating) => rating.id))
  const curveIds = new Set(curves.map((curve) => curve.id))
  return compares.filter((compare) => ratingIds.has(compare.ratingId) || (compare.curveId && curveIds.has(compare.curveId)))
}

/** 从当前原始测次重新读取点据来源；找不到来源时不覆盖旧快照，只登记为无法复核 */
export function refreshRatingFromSource(params: {
  rating: Rating
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
}): { rating: Rating; error?: string; snapshot: RatingSourceSnapshot | null } {
  const { rating, sections, verticals, points } = params
  const sectionId = rating.sourceRef?.sectionId
  const section = sections.find((item) => item.id === sectionId)
  if (!sectionId || !section) {
    return {
      rating,
      error: '来源断面缺失或已删除，需补录来源后再确认',
      snapshot: rating.sourceSnapshot ?? null
    }
  }
  const sourceVertical = verticals.find((item) => item.id === rating.sourceRef?.verticalId)
  const relatedVerticals = sourceVertical
    ? verticals.filter((item) => item.sectionId === section.id && item.id === sourceVertical.id)
    : verticals.filter((item) => item.sectionId === section.id)
  const relatedPoints = points.filter((point) => relatedVerticals.some((vertical) => vertical.id === point.verticalId))
  if (relatedVerticals.length === 0 || relatedPoints.length === 0) {
    return {
      rating,
      error: '来源垂线或测点缺失，需补录原始测次后再确认',
      snapshot: rating.sourceSnapshot ?? null
    }
  }
  const snapshot = buildRatingSourceSnapshot(section, relatedVerticals, relatedPoints)
  return {
    rating: {
      ...rating,
      stationId: section.stationId,
      measureNo: section.measureNo,
      measuredAt: section.measuredAt,
      stageM: section.stageM,
      flowM3s: snapshot.flow?.flowM3s || rating.flowM3s,
      direction: rating.direction === '未知' ? section.trend : rating.direction,
      sourceSnapshot: snapshot,
      sourceSnapshotAt: snapshot.capturedAt,
      staleReason: ''
    },
    snapshot
  }
}

/** 水位区间重叠且两支流量大小关系发生反转，视为绳套交叉冲突；冲突点优先列示 */
export function detectBranchConflicts(ratings: Rating[], lineNo: string): ReviewConflict[] {
  const rising = ratings.filter((rating) => rating.lineNo === lineNo && rating.direction === '涨水')
  const falling = ratings.filter((rating) => rating.lineNo === lineNo && rating.direction === '退水')
  const conflicts: ReviewConflict[] = []
  const conflictIds = new Set<string>()

  rising.forEach((rise) => {
    falling.forEach((fall) => {
      const overlap = Math.abs(rise.stageM - fall.stageM) <= 0.02
      if (!overlap) return
      // 同一水位处按常规洪水绳套，退水流量通常大于涨水；反之判为两支交叉。
      const crossed = rise.flowM3s > fall.flowM3s
      if (!crossed) return
      ;[rise, fall].forEach((rating) => {
        if (conflictIds.has(rating.id)) return
        conflictIds.add(rating.id)
        conflicts.push({
          stationId: rating.stationId,
          lineNo,
          branch: rating.direction,
          rating,
          message: `水位 ${rating.stageM.toFixed(2)} m 处涨水/退水点据重叠且绳套分支交叉`,
          severity: 'conflict'
        })
      })
    })
  })
  return conflicts.sort((a, b) => b.rating.stageM - a.rating.stageM)
}

/** 已拟合分支的共同水位区间若出现曲线流量反号，则绳套交叉；区间内测次优先列冲突。 */
function detectFittedCrossing(
  stationId: string,
  lineNo: string,
  fits: Array<{ branch: RatingDirection; fit: RatingFitResult; ratings: Rating[] }>
): ReviewConflict[] {
  const rising = fits.find((item) => item.branch === '涨水')
  const falling = fits.find((item) => item.branch === '退水')
  if (!rising?.fit.valid || !falling?.fit.valid) return []
  const risingStages = rising.ratings.map((rating) => rating.stageM)
  const fallingStages = falling.ratings.map((rating) => rating.stageM)
  const min = Math.max(Math.min(...risingStages), Math.min(...fallingStages))
  const max = Math.min(Math.max(...risingStages), Math.max(...fallingStages))
  if (max < min) return []
  const valueAt = (item: typeof rising, stage: number): number => curveFlow(item.fit, stage)
  let crossingStage: number | null = null
  for (let index = 1; index <= 40; index += 1) {
    const left = min + ((max - min) * (index - 1)) / 40
    const right = min + ((max - min) * index) / 40
    if ((valueAt(rising, left) - valueAt(falling, left)) * (valueAt(rising, right) - valueAt(falling, right)) < 0) {
      crossingStage = (left + right) / 2
      break
    }
  }
  if (crossingStage === null) return []
  const nearest = (ratings: Rating[]): Rating =>
    ratings.reduce((best, rating) =>
      Math.abs(rating.stageM - (crossingStage as number)) < Math.abs(best.stageM - (crossingStage as number)) ? rating : best
    )
  return [rising.ratings, falling.ratings].map((ratings) => {
    const rating = nearest(ratings)
    return {
      stationId,
      lineNo,
      branch: rating.direction,
      rating,
      message: `涨水/退水曲线在水位 ${(crossingStage as number).toFixed(2)} m 附近交叉，请优先核对该分支测次`,
      severity: 'conflict' as const
    }
  })
}

function validateCandidates(candidates: Rating[]): ReviewConflict[] {
  const issues: ReviewConflict[] = []
  candidates.forEach((rating) => {
    if (rating.direction === '未知') {
      issues.push({
        stationId: rating.stationId,
        lineNo: rating.lineNo,
        branch: '未知',
        rating,
        message: '涨水/退水方向不明，已保留在待确认',
        severity: 'missing'
      })
    }
    if (!rating.sourceRef?.sectionId || !rating.sourceSnapshot?.section) {
      issues.push({
        stationId: rating.stationId,
        lineNo: rating.lineNo,
        branch: rating.direction,
        rating,
        message: '缺少来源断面或流量快照，已保留在待确认',
        severity: 'missing'
      })
    }
  })
  return issues
}

function createConfirmedCurve(params: {
  stationId: string
  lineNo: string
  branch: RatingDirection
  fit: RatingFitResult
  ratings: Rating[]
  previous: RatingCurve | null
  batchId: string
  timestamp: number
}): RatingCurve {
  const { stationId, lineNo, branch, fit, ratings, previous, batchId, timestamp } = params
  return {
    id: createId('crv'),
    stationId,
    lineNo,
    branch,
    version: previous ? previous.version + 1 : 1,
    status: 'confirmed',
    fit,
    ratingIds: ratings.map((rating) => rating.id),
    previousCurveId: previous?.id ?? null,
    supersededByCurveId: null,
    reviewBatchId: batchId,
    reviewNote: `${lineNo} 线${branch}分支复核确认`,
    confirmedBy: '资料复核员',
    confirmedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

function makeCompares(curves: RatingCurve[], ratings: Rating[], timestamp: number): Compare[] {
  return curves.flatMap((curve) =>
    curve.ratingIds
      .map((ratingId) => ratings.find((rating) => rating.id === ratingId))
      .filter((rating): rating is Rating => Boolean(rating))
      .map((rating) => {
        const predicted = curveFlow(curve.fit, rating.stageM)
        const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
        return {
          id: createId('cmp'),
          ratingId: rating.id,
          curveId: curve.id,
          branch: curve.branch,
          lineNo: curve.lineNo,
          measuredFlow: rating.flowM3s,
          curveFlow: predicted,
          deviationPct,
          verdict: judgeDeviation(deviationPct),
          operator: curve.confirmedBy,
          comparedAt: new Date(timestamp).toISOString(),
          createdAt: timestamp,
          updatedAt: timestamp
        }
      })
  )
}

/**
 * 复核某测站一条绳套定线。
 * 交叉或缺来源点据先列冲突；任一校验失败时恢复上次确认的点据、曲线与比测，不覆盖已确认成果。
 */
export async function reviewStationLine(params: {
  stationId: string
  lineNo: string
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  operator?: string
}): Promise<StationReviewResult> {
  const { stationId, lineNo, sections, verticals, points, operator = '资料复核员' } = params
  const timestamp = now()
  const batchId = createId('rb')
  const allRatings = await db.ratings.toArray()
  const allCurves = await db.ratingCurves.toArray()
  const allCompares = await db.compares.toArray()
  const scopedBeforeRatings = scopeRatings(allRatings, stationId, lineNo)
  const scopedBeforeCurves = scopeCurves(allCurves, stationId, lineNo)
  const scopedBeforeCompares = scopeCompares(allCompares, scopedBeforeRatings, scopedBeforeCurves)
  const previousBatch = await db.reviewBatches
    .where('[stationId+lineNo]')
    .equals([stationId, lineNo])
    .filter((batch) => batch.status === 'success' && batch.id !== 'rb_seed')
    .reverse()
    .first()
  const lastConfirmed = previousBatch?.status === 'success' ? previousBatch : null

  const candidates = scopedBeforeRatings.filter((rating) => rating.status !== 'confirmed')
  const refreshed = candidates.map((rating) =>
    refreshRatingFromSource({ rating, sections, verticals, points })
  )
  const refreshedErrors = refreshed
    .filter((item) => item.error)
    .map<ReviewConflict>((item) => ({
      stationId,
      lineNo,
      branch: item.rating.direction,
      rating: item.rating,
      message: item.error ?? '来源无法复核',
      severity: 'missing'
    }))
  const refreshedRatings = refreshed.map((item) => item.rating)
  const candidateById = new Map(refreshedRatings.map((rating) => [rating.id, rating]))
  const projected = scopedBeforeRatings.map((rating) => candidateById.get(rating.id) ?? rating)
  const branches: RatingDirection[] = ['涨水', '退水']
  const fits = branches.map((branch) => {
    const branchRatings = projected.filter(
      (rating) => rating.direction === branch && (rating.status === 'confirmed' || candidateById.has(rating.id))
    )
    return {
      branch,
      fit: fitPowerCurve(
        branchRatings.map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
        lineNo,
        branch
      ),
      ratings: branchRatings
    }
  })
  const conflicts = [
    ...detectBranchConflicts(projected, lineNo).filter((conflict) =>
      candidates.some((rating) => rating.id === conflict.rating.id)
    ),
    ...detectFittedCrossing(stationId, lineNo, fits),
    ...validateCandidates(refreshedRatings),
    ...refreshedErrors
  ]
  const fitErrors = fits
    .filter((item) => !item.fit.valid)
    .map((item) => item.fit.message || `${item.branch}分支点据不足，至少需要 3 个来源完整的点据`)

  const makeBatch = (status: ReviewBatch['status'], errors: string[]): ReviewBatch => ({
    id: batchId,
    stationId,
    lineNo,
    status,
    conflictCount: conflicts.length,
    errors,
    beforeRatings: scopedBeforeRatings,
    beforeCurves: scopedBeforeCurves,
    beforeCompares: scopedBeforeCompares,
    afterRatings: lastConfirmed?.afterRatings,
    afterCurves: lastConfirmed?.afterCurves,
    afterCompares: lastConfirmed?.afterCompares,
    confirmedCurveIds: [],
    reviewedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  })

  if (conflicts.length > 0 || fitErrors.length > 0) {
    const errors = [...conflicts.map((conflict) => conflict.message), ...fitErrors]
    const batch = makeBatch('failed', errors)
    const restoreRatings = lastConfirmed?.afterRatings ?? scopedBeforeRatings
    const restoreCurves = lastConfirmed?.afterCurves ?? scopedBeforeCurves
    const restoreCompares = lastConfirmed?.afterCompares ?? scopedBeforeCompares
    await db.transaction(
      'rw',
      [db.ratings, db.ratingCurves, db.compares, db.reviewBatches],
      async () => {
        await db.ratings.bulkPut(restoreRatings)
        await db.ratingCurves.bulkPut(restoreCurves)
        await db.compares.bulkPut(restoreCompares)
        await db.reviewBatches.put({ ...batch, status: 'rolled_back' })
      }
    )
    return { batch: { ...batch, status: 'rolled_back' }, conflicts, curves: restoreCurves, compares: restoreCompares, ratings: restoreRatings }
  }

  const oldCurrentIds = new Set(
    scopedBeforeCurves.filter((curve) => curve.status === 'confirmed').map((curve) => curve.id)
  )
  const supersededCurves = scopedBeforeCurves.map((curve) =>
    oldCurrentIds.has(curve.id) ? { ...curve, status: 'superseded' as const, updatedAt: timestamp } : curve
  )
  const newCurves = fits.map(({ branch, fit, ratings }) =>
    createConfirmedCurve({
      stationId,
      lineNo,
      branch,
      fit: { ...fit, lineNo, branch, valid: true },
      ratings,
      previous: scopedBeforeCurves.find((curve) => curve.branch === branch && curve.status === 'confirmed') ?? null,
      batchId,
      timestamp
    })
  )
  const newCurveIds = new Set(newCurves.map((curve) => curve.id))
  const updatedCurves = supersededCurves.map((curve) =>
    newCurves.find((next) => next.previousCurveId === curve.id)
      ? { ...curve, supersededByCurveId: newCurves.find((next) => next.previousCurveId === curve.id)?.id ?? null }
      : curve
  )
  const curveById = new Map([...updatedCurves, ...newCurves].map((curve) => [curve.id, curve]))
  newCurves.forEach((curve) => {
    if (!curve.previousCurveId) return
    const previous = curveById.get(curve.previousCurveId)
    if (previous) previous.supersededByCurveId = curve.id
  })

  const confirmedIds = new Set(newCurves.flatMap((curve) => curve.ratingIds))
  const updatedRatings = projected.map((rating) =>
    confirmedIds.has(rating.id)
      ? {
          ...rating,
          status: 'confirmed' as const,
          confirmedCurveId: newCurves.find((curve) => curve.ratingIds.includes(rating.id))?.id ?? null,
          confirmedAt: timestamp,
          staleReason: '',
          updatedAt: timestamp
        }
      : rating
  )
  const newCompares = makeCompares(newCurves, updatedRatings, timestamp).map((compare) => ({
    ...compare,
    operator
  }))
  const batch: ReviewBatch = {
    ...makeBatch('success', []),
    afterRatings: updatedRatings,
    afterCurves: [...updatedCurves, ...newCurves],
    afterCompares: [...scopedBeforeCompares, ...newCompares],
    confirmedCurveIds: newCurves.map((curve) => curve.id)
  }

  await db.transaction(
    'rw',
    [db.ratings, db.ratingCurves, db.compares, db.reviewBatches],
    async () => {
      await db.ratings.bulkPut(updatedRatings)
      await db.ratingCurves.bulkPut([...updatedCurves, ...newCurves])
      await db.compares.bulkPut(newCompares)
      await db.reviewBatches.put(batch)
    }
  )

  return {
    batch,
    conflicts: [],
    curves: [...updatedCurves, ...newCurves],
    compares: [...scopedBeforeCompares, ...newCompares],
    ratings: updatedRatings
  }
}
