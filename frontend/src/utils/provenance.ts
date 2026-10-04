/**
 * 关系点据溯源工具：
 * - 从来源断面测次 + 垂线 + 测点构建流量快照（点据落档 / 复核刷新共用）；
 * - 依据测次时间序列（水位升降）推断涨水 / 退水方向。
 * 定线、复核、历史升级共用同一套算法，保证来源与方向口径一致。
 */
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { FlowSnapshot, RatingSourcePoint, TrendDirection } from '@/types/rating'
import { calcMeanVelocity, calcSectionDischarge, type VerticalSlice } from '@/utils/flow'

/** 构建一条关系点据所需的来源数据 */
export interface ProvenanceInput {
  section: Section
  verticals: Vertical[]
  points: Point[]
}

/** 溯源快照成果：快照本身 + 垂线 / 测点指针 */
export interface ProvenanceSnapshot {
  sourceSectionId: string
  sourceVerticalIds: string[]
  sourcePoints: RatingSourcePoint[]
  snapshot: FlowSnapshot
}

/**
 * 由来源测次成果构建流量快照：逐垂线算平均流速，再用部分面积法汇总断面流量。
 * 垂线 / 测点均按当时的成果原样登记，供点据长期追溯。
 */
export function buildProvenanceSnapshot(input: ProvenanceInput, capturedAt = new Date().toISOString()): ProvenanceSnapshot {
  const { section, verticals, points } = input
  const sectionVerticals = verticals
    .filter((vertical) => vertical.sectionId === section.id)
    .sort((a, b) => a.startDistanceM - b.startDistanceM)

  const sourcePoints: RatingSourcePoint[] = []
  const slices: VerticalSlice[] = sectionVerticals.map((vertical) => {
    const verticalPoints = points
      .filter((point) => point.verticalId === vertical.id)
      .sort((a, b) => a.relativeDepth - b.relativeDepth)
    verticalPoints.forEach((point) => {
      sourcePoints.push({
        pointId: point.id,
        relativeDepth: point.relativeDepth,
        velocityMs: point.velocityMs,
        weight: point.weight
      })
    })
    const meanVelocityMs = calcMeanVelocity(
      verticalPoints.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight }))
    )
    return {
      id: vertical.id,
      no: vertical.no,
      startDistanceM: vertical.startDistanceM,
      depthM: vertical.depthM,
      meanVelocityMs
    }
  })

  const discharge = calcSectionDischarge(slices)
  const snapshot: FlowSnapshot = {
    stageM: section.stageM,
    flowM3s: discharge.flowM3s,
    areaM2: discharge.areaM2,
    meanVelocityMs: discharge.meanVelocityMs,
    verticalCount: sectionVerticals.length,
    pointCount: sourcePoints.length,
    capturedAt,
    sourceUpdatedAt: section.updatedAt ?? 0
  }
  return {
    sourceSectionId: section.id,
    sourceVerticalIds: sectionVerticals.map((vertical) => vertical.id),
    sourcePoints,
    snapshot
  }
}

/**
 * 按测流时间排序的测次水位序列条目
 */
export interface StageSeriesEntry {
  measureKey: string
  measuredAt: string
  stageM: number
}

/**
 * 对整条测次序列批量推断方向（历史数据升级与批量落档共用）：
 * 相邻测次比较水位，上升记涨水、下降记退水、持平沿用前一个方向；首个测次方向不明。
 */
export function inferDirections(ordered: StageSeriesEntry[]): Map<string, TrendDirection> {
  const result = new Map<string, TrendDirection>()
  const sorted = [...ordered].sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt))
  let lastDirection: TrendDirection = '不明'
  let lastStage: number | null = null
  sorted.forEach((entry) => {
    if (lastStage === null) {
      result.set(entry.measureKey, '不明')
    } else if (entry.stageM > lastStage) {
      lastDirection = '涨水'
      result.set(entry.measureKey, '涨水')
    } else if (entry.stageM < lastStage) {
      lastDirection = '退水'
      result.set(entry.measureKey, '退水')
    } else {
      result.set(entry.measureKey, lastDirection)
    }
    lastStage = entry.stageM
  })
  return result
}
