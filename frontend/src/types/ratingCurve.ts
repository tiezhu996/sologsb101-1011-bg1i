import type { RatingDirection, CurveStatus } from './ratingDirection'
import type { RatingFitResult } from './rating'

/** 一个测站一条定线号下，某次确认后形成的涨/退水分支曲线 */
export interface RatingCurve {
  id: string
  stationId: string
  /** 同一绳套定线号，如 A；涨水/退水由 branch 区分 */
  lineNo: string
  branch: RatingDirection
  version: number
  status: CurveStatus
  fit: RatingFitResult
  /** 本次确认参与拟合的关系点据 */
  ratingIds: string[]
  /** 上一版本曲线；新绳套（无旧版本）时为空 */
  previousCurveId: string | null
  supersededByCurveId: string | null
  reviewBatchId: string
  reviewNote: string
  confirmedBy: string
  confirmedAt: number
  createdAt: number
  updatedAt: number
}

export function branchLineKey(stationId: string, lineNo: string, branch: RatingDirection): string {
  return `${stationId}::${lineNo}::${branch}`
}
