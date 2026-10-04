/** 水位流量关系点据的洪水分支方向 */
export type RatingDirection = '涨水' | '退水' | '未知'

export const RATING_DIRECTIONS: RatingDirection[] = ['涨水', '退水']

export type RatingStatus = 'confirmed' | 'pending' | 'stale'

export const RATING_STATUS_LABEL: Record<RatingStatus, string> = {
  confirmed: '已确认',
  pending: '待确认',
  stale: '原始测次已更新'
}

export type CurveStatus = 'confirmed' | 'superseded' | 'invalid'

export const CURVE_STATUS_LABEL: Record<CurveStatus, string> = {
  confirmed: '已确认',
  superseded: '已替代',
  invalid: '已失效'
}
