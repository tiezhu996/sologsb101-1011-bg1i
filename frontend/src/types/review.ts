import type { Compare } from './compare'
import type { Rating } from './rating'
import type { RatingCurve } from './ratingCurve'
import type { RatingDirection } from './ratingDirection'

export type ReviewBatchStatus = 'success' | 'failed' | 'rolled_back'

/** 同一测站、同一定线号的一次复核提交，保留成功与失败后的恢复依据 */
export interface ReviewBatch {
  id: string
  stationId: string
  lineNo: string
  status: ReviewBatchStatus
  requestedDirection?: RatingDirection
  conflictCount: number
  errors: string[]
  /** 提交前点据快照，用于复核失败恢复到上次确认状态 */
  beforeRatings: Rating[]
  /** 提交前曲线快照，避免复核失败改变已确认绳套 */
  beforeCurves: RatingCurve[]
  /** 提交前比测快照 */
  beforeCompares: Compare[]
  /** 上次确认后的完整状态，供失败批次恢复到上次确认测次 */
  afterRatings?: Rating[]
  afterCurves?: RatingCurve[]
  afterCompares?: Compare[]
  confirmedCurveIds: string[]
  reviewedAt: number
  createdAt: number
  updatedAt: number
}

export interface ReviewConflict {
  stationId: string
  lineNo: string
  branch: RatingDirection
  rating: Rating
  message: string
  severity: 'conflict' | 'missing'
}

export interface StationReviewResult {
  batch: ReviewBatch
  conflicts: ReviewConflict[]
  curves: RatingCurve[]
  compares: Compare[]
  ratings: Rating[]
}
