/** 洪水过程方向：涨水支 / 退水支。绳套定线同一水位下两支流量不同 */
export type TrendDirection = '涨水' | '退水' | '不明'

export const TREND_DIRECTIONS: TrendDirection[] = ['涨水', '退水', '不明']

/**
 * 点据复核状态（可追溯定线的生命周期）：
 * - 已确认：参与已确认曲线的定线
 * - 待确认：来源缺失 / 方向不明 / 手工新增，等待复核，不参与任何已确认曲线
 * - 待复核：来源测次成果已更新（补录或重测），旧曲线已失效，等待复核重算
 */
export type RatingPointStatus = '已确认' | '待确认' | '待复核'

export const RATING_POINT_STATUSES: RatingPointStatus[] = ['已确认', '待确认', '待复核']

/** 单个来源测点的溯源指针（垂线测速点） */
export interface RatingSourcePoint {
  pointId: string
  /** 相对水深（0 水面，1 河底），冗余留存便于离线追溯 */
  relativeDepth: number
  /** 测点流速（m/s），冗余留存 */
  velocityMs: number
  /** 计算权重 */
  weight: number
}

/**
 * 流量快照：关系点据从来源测次落档时的断面成果副本。
 * 原始测次补录 / 重测后不会就地覆盖本快照，而是触发「快照待更新」并进入复核，
 * 复核通过后才整体替换，保证每一次定线用的是什么数据可追溯。
 */
export interface FlowSnapshot {
  /** 快照水位（m），一般等于来源断面水位 */
  stageM: number
  /** 快照断面流量（m³/s），点据落档时的定线用值 */
  flowM3s: number
  /** 断面面积（m²） */
  areaM2: number
  /** 断面平均流速（m/s） */
  meanVelocityMs: number
  /** 参与计算的测速垂线数 */
  verticalCount: number
  /** 参与计算的测点数 */
  pointCount: number
  /** 快照抓取时间（ISO） */
  capturedAt: string
  /** 快照所依据的测次成果更新时间（ms），用于判断测次是否又被改动 */
  sourceUpdatedAt: number
}

/** 水位流量关系点据：参与幂函数绳套定线的实测点，可追溯到来源测次与流量快照 */
export interface Rating {
  id: string
  /** 所属测站 */
  stationId: string
  /** 水位（m）：取流量快照水位，手工录入时为本字段 */
  stageM: number
  /** 流量（m³/s）：定线当前采用值；快照待更新时保留旧值，不直接覆盖 */
  flowM3s: number
  /** 定线号：同一测站同一线号的点据参与同一组绳套拟合 */
  lineNo: string
  /** 点据来源测次号（冗余，便于列表展示） */
  measureNo: string
  /** 点据时间 */
  measuredAt: string

  /* ---------------------------- 可追溯来源 ---------------------------- */
  /** 来源断面测次 id；手工录入或缺来源的历史点据为 null */
  sourceSectionId: string | null
  /** 参与断面流量计算的来源垂线 id 列表 */
  sourceVerticalIds: string[]
  /** 参与计算的来源测点指针（逐条垂线的测速点） */
  sourcePoints: RatingSourcePoint[]
  /** 落档时的流量快照；缺来源的历史点据为 null */
  snapshot: FlowSnapshot | null
  /** 快照是否已与来源测次脱节（测次补录 / 重测后置 true，旧值仍保留） */
  snapshotStale: boolean

  /* ---------------------------- 方向与状态 ---------------------------- */
  /** 涨水 / 退水分支；方向不明的点据留在待确认，不参与定线 */
  direction: TrendDirection
  /** 点据复核状态 */
  status: RatingPointStatus
  /** 当前占用该点据的复核批次 id（进行中的批次锁定点据） */
  reviewBatchId: string | null
  /** 备注（来源缺失原因、复核说明等） */
  note: string

  createdAt: number
  updatedAt: number
}

/** 幂函数定线结果：Q = a * (H - H0)^b */
export interface RatingFitResult {
  lineNo: string
  /** 分支：涨水 / 退水 / 综合（旧单线逻辑兜底） */
  branch: TrendDirection | '综合'
  /** 系数 a */
  a: number
  /** 指数 b */
  b: number
  /** 基线水位 H0（由点据自动搜索获得） */
  h0: number
  /** 参与拟合的点数 */
  sampleCount: number
  /** 拟合残差（相对误差绝对值均值，%） */
  meanResidualPct: number
  /** 最大残差（%） */
  maxResidualPct: number
  /** 决定系数 R²（对数域） */
  r2: number
  /** 是否可定线（点数 ≥ 3 且 b 为正） */
  valid: boolean
  /** 不可定线时的说明 */
  message: string
}

/** 关系点据页筛选条件（存于 ratingStore） */
export interface RatingFilterState {
  keyword: string
  stationIds: string[]
  lineNos: string[]
  directions: TrendDirection[]
  statuses: RatingPointStatus[]
  verdicts: Array<'合格' | '超限'>
}

export function createEmptyRatingFilter(): RatingFilterState {
  return {
    keyword: '',
    stationIds: [],
    lineNos: [],
    directions: [],
    statuses: [],
    verdicts: []
  }
}

/** 对 ln(Q) 与 ln(H - H0) 做最小二乘直线拟合，给定 H0 返回参数与残差 */
function fitWithBase(
  samples: Array<{ stageM: number; flowM3s: number }>,
  h0: number
): { a: number; b: number; residuals: number[] } | null {
  const points = samples.map((point) => ({
    x: Math.log(Math.max(point.stageM - h0, 1e-6)),
    y: Math.log(point.flowM3s)
  }))
  const n = points.length
  const sumX = points.reduce((sum, item) => sum + item.x, 0)
  const sumY = points.reduce((sum, item) => sum + item.y, 0)
  const sumXY = points.reduce((sum, item) => sum + item.x * item.y, 0)
  const sumXX = points.reduce((sum, item) => sum + item.x * item.x, 0)
  const denominator = n * sumXX - sumX * sumX
  if (Math.abs(denominator) < 1e-9) return null
  const b = (n * sumXY - sumX * sumY) / denominator
  const lnA = (sumY - b * sumX) / n
  const a = Math.exp(lnA)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null
  const residuals = samples.map((point) => {
    const predicted = a * Math.pow(Math.max(point.stageM - h0, 1e-6), b)
    return Math.abs((predicted - point.flowM3s) / point.flowM3s) * 100
  })
  return { a, b, residuals }
}

/**
 * 幂函数定线：Q = a×(H - H0)^b。
 * 在 [Hmin - 0.9×(Hmax-Hmin) , Hmin - 0.02] 区间内以 0.01 m 步长搜索 H0，
 * 取平均相对残差最小的一组参数，避免「基线贴近最低水位」造成幂函数畸变。
 */
export function fitPowerCurve(
  points: Array<{ stageM: number; flowM3s: number }>,
  lineNo = 'A',
  branch: TrendDirection | '综合' = '综合'
): RatingFitResult {
  const usable = points.filter(
    (point) => Number.isFinite(point.stageM) && Number.isFinite(point.flowM3s) && point.flowM3s > 0
  )
  const base: RatingFitResult = {
    lineNo,
    branch,
    a: 0,
    b: 0,
    h0: 0,
    sampleCount: usable.length,
    meanResidualPct: 0,
    maxResidualPct: 0,
    r2: 0,
    valid: false,
    message: ''
  }
  if (usable.length < 3) {
    return { ...base, message: `${branch === '综合' ? '' : branch + '支'}点据少于 3 个，无法定线（至少需要 3 个实测点）` }
  }
  const stageMin = Math.min(...usable.map((point) => point.stageM))
  const stageMax = Math.max(...usable.map((point) => point.stageM))
  const spread = Math.max(stageMax - stageMin, 0.05)
  const lowerH0 = stageMin - spread * 0.9
  const upperH0 = stageMin - 0.02

  let best: { a: number; b: number; h0: number; residuals: number[]; mean: number } | null = null
  const steps = Math.max(1, Math.round((upperH0 - lowerH0) / 0.01))
  for (let index = 0; index <= steps; index += 1) {
    const h0 = Number((lowerH0 + (index * (upperH0 - lowerH0)) / steps).toFixed(4))
    const candidate = fitWithBase(usable, h0)
    if (!candidate) continue
    const mean = candidate.residuals.reduce((sum, value) => sum + value, 0) / candidate.residuals.length
    if (!best || mean < best.mean) {
      best = { ...candidate, h0, mean }
    }
  }
  if (!best) {
    return { ...base, message: '水位点据过于集中，无法求解幂函数指数' }
  }

  // 对数域决定系数 R²
  const lnFlows = usable.map((point) => Math.log(point.flowM3s))
  const meanLnFlow = lnFlows.reduce((sum, value) => sum + value, 0) / lnFlows.length
  const totalSs = lnFlows.reduce((sum, value) => sum + (value - meanLnFlow) ** 2, 0)
  const residualSs = usable.reduce((sum, point) => {
    const predicted = best.a * Math.pow(Math.max(point.stageM - best.h0, 1e-6), best.b)
    const diff = Math.log(point.flowM3s) - Math.log(Math.max(predicted, 1e-6))
    return sum + diff * diff
  }, 0)
  const r2 = totalSs < 1e-9 ? 1 : Number(Math.max(0, 1 - residualSs / totalSs).toFixed(4))

  // 允许 b ≤ 0：涨 / 退分支拟合时，退水点据可能出现水位升高而流量减小，
  // 此时曲线本身可用于两支交叉检测（交叉正是点据矛盾的证据），由复核环节拦截。
  const valid = Number.isFinite(best.a) && Number.isFinite(best.b)
  return {
    lineNo,
    branch,
    a: Number(best.a.toFixed(4)),
    b: Number(best.b.toFixed(3)),
    h0: Number(best.h0.toFixed(3)),
    sampleCount: usable.length,
    meanResidualPct: Number(best.mean.toFixed(2)),
    maxResidualPct: Number(Math.max(...best.residuals).toFixed(2)),
    r2,
    valid,
    message:
      best.b > 0
        ? `${branch === '综合' ? '' : branch + '支'}定线有效`
        : `${branch === '综合' ? '' : branch + '支'}指数 b=${Number(best.b.toFixed(3))} ≤ 0，点据趋势异常（水位升高而流量减小），可用于交叉检测但须复核处理`
  }
}

/** 由定线参数计算曲线流量 */
export function curveFlow(fit: Pick<RatingFitResult, 'valid' | 'a' | 'b' | 'h0'>, stageM: number): number {
  if (!fit.valid) return 0
  const value = fit.a * Math.pow(Math.max(stageM - fit.h0, 1e-6), fit.b)
  return Number(value.toFixed(2))
}

/** 点据是否具备参与定线的资格：已确认且方向明确 */
export function isPointUsableForCurve(rating: Pick<Rating, 'status' | 'direction'>): boolean {
  return rating.status === '已确认' && rating.direction !== '不明'
}
