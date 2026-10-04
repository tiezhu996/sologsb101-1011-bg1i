import type { TrendDirection } from './rating'
import type { RatingFitResult } from './rating'
import { curveFlow } from './rating'

/** 复核批次状态 */
export type ReviewStatus = '进行中' | '已确认' | '已回滚'

/** 复核中的点据视图：保留旧值快照与（可能已刷新的）新值，供逐点核对 */
export interface ReviewPointItem {
  ratingId: string
  /** 涨水 / 退水 / 不明（复核中可人工改分支） */
  direction: TrendDirection
  /** 是否纳入本次定线（来源缺失 / 方向不明的点据默认排除） */
  included: boolean
  /** 复核开始时保留的旧水位（m），即旧定线采用值 */
  previousStageM: number
  /** 复核开始时保留的旧流量（m³/s） */
  previousFlowM3s: number
  /** 复核采用水位（m）：刷新后的快照值；未刷新时等于旧值 */
  stageM: number
  /** 复核采用流量（m³/s） */
  flowM3s: number
  /** 快照是否与来源测次脱节 */
  snapshotStale: boolean
}

/**
 * 分支交叉冲突：水位重叠区内，涨水支与退水支拟合曲线发生交叉。
 * 绳套曲线同一水位下两支应保持稳定的大小关系，交叉意味着两支点据矛盾，
 * 必须先处理（剔除矛盾点 / 调整分支）才能确认复核。
 */
export interface BranchCrossConflict {
  /** 发生交叉的水位（m） */
  stageM: number
  /** 该水位下涨水支流量（m³/s） */
  risingFlowM3s: number
  /** 该水位下退水支流量（m³/s） */
  fallingFlowM3s: number
  /** 交叉描述 */
  message: string
}

/**
 * 复核批次：一次「旧定线失效 → 重新拟合 → 确认 / 回滚」的事务单元。
 * 进行中只做试算，不覆盖任何已确认曲线；确认成功才提交新版本曲线，
 * 失败（交叉冲突未处理 / 拟合无效）可回滚到批次开始时上次确认的测次状态。
 */
export interface ReviewBatch {
  id: string
  /** 所属测站 */
  stationId: string
  /** 定线号 */
  lineNo: string
  /** 进行中 / 已确认 / 已回滚 */
  status: ReviewStatus
  /** 纳入复核的点据视图 */
  items: ReviewPointItem[]
  /** 开始时上次确认曲线 id（回滚目标，可能为 null 表示此前无已定线） */
  baselineCurveId: string | null
  /** 开始时各点据状态的备份（回滚用：ratingId → 状态/方向/快照值） */
  rollback: Record<
    string,
    {
      status: import('./rating').RatingPointStatus
      direction: TrendDirection
      stageM: number
      flowM3s: number
      snapshotStale: boolean
      reviewBatchId: string | null
    }
  >
  /** 开始时失效的旧曲线 id（确认时把它置为「已失效」；回滚时恢复为「已确认」） */
  touchedCurveIds: string[]
  /** 试算涨水支拟合 */
  risingFit: RatingFitResult | null
  /** 试算退水支拟合 */
  fallingFit: RatingFitResult | null
  /** 检出的分支交叉冲突 */
  conflicts: BranchCrossConflict[]
  /** 复核结论说明 */
  message: string
  /** 发起人 */
  operator: string
  createdAt: number
  updatedAt: number
  /** 确认 / 回滚时间（ISO） */
  finishedAt: string | null
}

/** 某分支在给定点据集上的参与点（仅纳入 included 且方向一致） */
export function branchSamples(
  items: ReviewPointItem[],
  direction: Exclude<TrendDirection, '不明'>
): Array<{ stageM: number; flowM3s: number }> {
  return items
    .filter((item) => item.included && item.direction === direction)
    .map((item) => ({ stageM: item.stageM, flowM3s: item.flowM3s }))
}

/**
 * 检测涨 / 退两支在水位重叠区内是否交叉。
 * 重叠区内逐 0.01 m 采样比较两支流量，若相邻采样的大小关系发生翻转，
 * 在翻转区间内用线性插值求交叉水位。同一水位两支流量相等本身也记为交叉。
 */
export function detectBranchCross(
  rising: RatingFitResult,
  falling: RatingFitResult,
  samples: { rising: Array<{ stageM: number }>; falling: Array<{ stageM: number }> }
): BranchCrossConflict[] {
  if (!rising.valid || !falling.valid) return []
  const risingStages = samples.rising.map((item) => item.stageM)
  const fallingStages = samples.falling.map((item) => item.stageM)
  if (risingStages.length === 0 || fallingStages.length === 0) return []
  const overlapMin = Math.max(Math.min(...risingStages), Math.min(...fallingStages))
  const overlapMax = Math.min(Math.max(...risingStages), Math.max(...fallingStages))
  if (overlapMax - overlapMin < 0.01) return []

  const conflicts: BranchCrossConflict[] = []
  const step = 0.01
  const count = Math.max(1, Math.ceil((overlapMax - overlapMin) / step))
  let prevStage = overlapMin
  let prevDiff = curveFlow(rising, prevStage) - curveFlow(falling, prevStage)

  for (let index = 1; index <= count; index += 1) {
    const stageM = Number(Math.min(overlapMin + step * index, overlapMax).toFixed(3))
    const risingFlow = curveFlow(rising, stageM)
    const fallingFlow = curveFlow(falling, stageM)
    const diff = risingFlow - fallingFlow
    if (Math.abs(diff) < 1e-6 || prevDiff * diff < 0) {
      // 线性插值求交叉水位
      const ratio = Math.abs(prevDiff) < 1e-6 ? 0 : Math.abs(prevDiff) / (Math.abs(prevDiff) + Math.abs(diff))
      const crossStage = Number((prevStage + (stageM - prevStage) * ratio).toFixed(3))
      const crossRising = curveFlow(rising, crossStage)
      const crossFalling = curveFlow(falling, crossStage)
      conflicts.push({
        stageM: crossStage,
        risingFlowM3s: crossRising,
        fallingFlowM3s: crossFalling,
        message: `水位 ${crossStage.toFixed(2)} m 处涨水支（${crossRising.toFixed(1)}）与退水支（${crossFalling.toFixed(
          1
        )}）交叉，绳套两支点据矛盾，请先剔除矛盾测次或调整分支`
      })
      // 一次检出即可让用户先处理；继续扫描可能产生重复，故只报首个
      break
    }
    prevStage = stageM
    prevDiff = diff
  }
  return conflicts
}
