/**
 * 绳套曲线与比测的组装工具（纯函数，不触碰数据库）：
 * - 由已确认点据按涨水 / 退水分支拟合并组装一条新版本曲线；
 * - 按已确认曲线重算比测记录；
 * - 测次补录 / 重测后标记点据快照脱节、失效旧曲线。
 * 数据库升级、演示播种与复核事务共用同一套口径。
 */
import type { Rating } from '@/types/rating'
import { curveFlow, fitPowerCurve, isPointUsableForCurve } from '@/types/rating'
import type { RatingCurve, CurveBranch } from '@/types/curve'
import type { Compare } from '@/types/compare'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'

/** 组装一支（涨水 / 退水）的拟合结果与点据集合 */
function buildBranch(
  ratings: Rating[],
  lineNo: string,
  direction: '涨水' | '退水'
): CurveBranch | null {
  const branchRatings = ratings.filter(
    (rating) => isPointUsableForCurve(rating) && rating.direction === direction
  )
  if (branchRatings.length === 0) return null
  const fit = fitPowerCurve(
    branchRatings.map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
    lineNo,
    direction
  )
  return { direction, ratingIds: branchRatings.map((rating) => rating.id), fit }
}

export interface BuildCurveInput {
  id: string
  stationId: string
  lineNo: string
  version: number
  ratings: Rating[]
  confirmedBy: string
  confirmedAt: string
  reviewBatchId?: string | null
  now: number
}

/** 由已确认点据组装一条绳套曲线（涨 / 退两支分别拟合） */
export function buildRatingCurve(input: BuildCurveInput): RatingCurve {
  const { id, stationId, lineNo, version, ratings, confirmedBy, confirmedAt, now } = input
  const scoped = ratings.filter(
    (rating) => rating.stationId === stationId && rating.lineNo === lineNo
  )
  const risingBranch = buildBranch(scoped, lineNo, '涨水')
  const fallingBranch = buildBranch(scoped, lineNo, '退水')
  const used = scoped.filter(isPointUsableForCurve)
  const stages = used.map((rating) => rating.stageM)
  return {
    id,
    stationId,
    lineNo,
    version,
    status: '已确认',
    risingBranch,
    fallingBranch,
    stageMinM: stages.length ? Math.min(...stages) : 0,
    stageMaxM: stages.length ? Math.max(...stages) : 0,
    ratingIds: used.map((rating) => rating.id),
    confirmedBy,
    confirmedAt,
    invalidatedAt: null,
    invalidateReason: '',
    supersededByCurveId: null,
    reviewBatchId: input.reviewBatchId ?? null,
    createdAt: now,
    updatedAt: now
  }
}

/** 曲线是否至少有一支可用于定线 */
export function curveHasValidBranch(curve: RatingCurve): boolean {
  return Boolean(curve.risingBranch?.fit.valid || curve.fallingBranch?.fit.valid)
}

/** 按点据方向取曲线上对应分支 */
export function curveBranchFor(
  curve: RatingCurve,
  direction: Rating['direction']
): CurveBranch | null {
  if (direction === '涨水') return curve.risingBranch
  if (direction === '退水') return curve.fallingBranch
  return null
}

/**
 * 依据当前已确认曲线为点据重建比测记录。
 * 仅对有有效分支、方向明确的已确认点据生成比测；曲线版本随记录可追溯。
 */
export function rebuildComparesForCurves(
  ratings: Rating[],
  curves: RatingCurve[],
  options: { operator?: string; now: number; limitPct?: number; keep?: Compare[] } = { now: Date.now() }
): Compare[] {
  const { now, keep = [] } = options
  const activeByKey = new Map<string, RatingCurve>()
  curves
    .filter((curve) => curve.status === '已确认')
    .forEach((curve) => activeByKey.set(`${curve.stationId}::${curve.lineNo}`, curve))

  const rows: Compare[] = []
  ratings.forEach((rating) => {
    if (rating.status !== '已确认' || rating.direction === '不明') return
    const curve = activeByKey.get(`${rating.stationId}::${rating.lineNo}`)
    const branch = curve ? curveBranchFor(curve, rating.direction) : null
    if (!curve || !branch?.fit.valid) return
    const predicted = curveFlow(branch.fit, rating.stageM)
    const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
    const existing = keep.find((item) => item.ratingId === rating.id)
    rows.push({
      id: existing?.id ?? `cmp_${rating.id}`,
      ratingId: rating.id,
      curveId: curve.id,
      branch: rating.direction,
      measuredFlow: rating.flowM3s,
      curveFlow: predicted,
      deviationPct,
      verdict: judgeDeviation(deviationPct, options.limitPct),
      operator: existing?.operator ?? options.operator ?? '林昭',
      comparedAt: existing?.comparedAt ?? rating.measuredAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    })
  })
  return rows
}

/**
 * 测次补录 / 重测后：把来源于该断面的、当前仍已确认的点据标记为快照脱节，
 * 并把其所属的已确认曲线登记为待失效（返回需要失效的曲线 id 集合）。
 * 不修改点据水位 / 流量旧值 —— 旧定线先失效，复核后再重算。
 */
export function markStaleForSection(
  ratings: Rating[],
  curves: RatingCurve[],
  sectionId: string
): { staleRatingIds: string[]; affectedCurveIds: string[] } {
  const staleRatingIds = ratings
    .filter((rating) => rating.sourceSectionId === sectionId)
    .map((rating) => rating.id)
  const staleSet = new Set(staleRatingIds)
  const affectedCurveIds = curves
    .filter(
      (curve) => curve.status === '已确认' && curve.ratingIds.some((id) => staleSet.has(id))
    )
    .map((curve) => curve.id)
  return { staleRatingIds, affectedCurveIds: Array.from(new Set(affectedCurveIds)) }
}
