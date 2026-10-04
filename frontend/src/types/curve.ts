import type { TrendDirection } from './rating'
import type { RatingFitResult } from './rating'

/**
 * 曲线复核状态：
 * - 已确认：最近一次复核确认、可用于比测推流的绳套定线
 * - 已失效：来源测次补录 / 重测后被新复核取代，保留留痕，不再参与比测
 */
export type CurveStatus = '已确认' | '已失效'

/** 一支（涨水 / 退水）的持久化拟合参数 */
export interface CurveBranch {
  /** 涨水 / 退水 */
  direction: Exclude<TrendDirection, '不明'>
  /** 参与该支拟合的点据 id（确认时的点据快照集合） */
  ratingIds: string[]
  /** 幂函数参数与拟合质量 */
  fit: RatingFitResult
}

/**
 * 绳套定线曲线：每个测站 × 定线号一条「当前版本」，复核后整体版本 +1。
 * 旧版本不就地覆盖：复核确认时把旧版本置为「已失效」并登记被哪个新版本替代，
 * 形成可追溯的版本链；已确认曲线始终保留可用于历史比测的追溯。
 */
export interface RatingCurve {
  id: string
  /** 所属测站 */
  stationId: string
  /** 定线号（A / B / C …） */
  lineNo: string
  /** 版本号，从 1 起单调递增 */
  version: number
  /** 已确认 / 已失效 */
  status: CurveStatus
  /** 涨水支（点据不足时 fit.valid=false） */
  risingBranch: CurveBranch | null
  /** 退水支 */
  fallingBranch: CurveBranch | null
  /** 定线水位适用下限 / 上限（m，取两支全部点据的水位范围） */
  stageMinM: number
  stageMaxM: number
  /** 本版本纳入的点据 id（涨 + 退） */
  ratingIds: string[]
  /** 复核人 */
  confirmedBy: string
  /** 复核确认时间（ISO） */
  confirmedAt: string
  /** 失效时间（ISO），仍确认时为 null */
  invalidatedAt: string | null
  /** 失效原因（补录 / 重测 / 复核取代） */
  invalidateReason: string
  /** 被哪条新曲线替代（旧版本留痕） */
  supersededByCurveId: string | null
  /** 触发本次定线的复核批次 id */
  reviewBatchId: string | null
  createdAt: number
  updatedAt: number
}

/** 判断曲线是否为某点据当前可用的已确认版本 */
export function isCurveActive(curve: Pick<RatingCurve, 'status'>): boolean {
  return curve.status === '已确认'
}

/** 取曲线某一分支（涨水 / 退水） */
export function branchOf(
  curve: RatingCurve,
  direction: Exclude<TrendDirection, '不明'>
): CurveBranch | null {
  return direction === '涨水' ? curve.risingBranch : curve.fallingBranch
}
