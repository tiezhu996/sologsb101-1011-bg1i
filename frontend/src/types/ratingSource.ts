import type { Point } from './point'
import type { Section } from './section'
import type { Vertical } from './vertical'
import type { DischargeResult } from '@/utils/flow'

/** 关系点据来源断面快照 */
export interface SourceSectionSnapshot {
  id: string
  measureNo: string
  stageM: number
  method: Section['method']
  measuredAt: string
  startDistanceM: number
}

/** 关系点据来源垂线快照 */
export interface SourceVerticalSnapshot {
  id: string
  no: number
  startDistanceM: number
  depthM: number
  pointCount: number
}

/** 关系点据来源测点快照 */
export interface SourcePointSnapshot {
  id: string
  relativeDepth: number
  velocityMs: number
  weight: number
  durationS: number
}

/**
 * 关系点据溯源快照。
 * section/flow 是点据形成时的断面与流量成果；verticals/points 保留当时参与成果的明细。
 */
export interface RatingSourceSnapshot {
  section: SourceSectionSnapshot | null
  verticals: SourceVerticalSnapshot[]
  points: SourcePointSnapshot[]
  flow: DischargeResult | null
  capturedAt: number
}

/** 点据当前来源定位（可为空；为空时只能停留在待确认） */
export interface RatingSourceRef {
  sectionId: string
  verticalId?: string
  pointId?: string
}

export function sectionToSnapshot(section: Omit<Section, 'createdAt' | 'updatedAt'>): SourceSectionSnapshot {
  return {
    id: section.id,
    measureNo: section.measureNo,
    stageM: section.stageM,
    method: section.method,
    measuredAt: section.measuredAt,
    startDistanceM: section.startDistanceM
  }
}

export function verticalToSnapshot(vertical: Omit<Vertical, 'createdAt' | 'updatedAt'>): SourceVerticalSnapshot {
  return {
    id: vertical.id,
    no: vertical.no,
    startDistanceM: vertical.startDistanceM,
    depthM: vertical.depthM,
    pointCount: vertical.pointCount
  }
}

export function pointToSnapshot(point: Omit<Point, 'createdAt' | 'updatedAt'>): SourcePointSnapshot {
  return {
    id: point.id,
    relativeDepth: point.relativeDepth,
    velocityMs: point.velocityMs,
    weight: point.weight,
    durationS: point.durationS
  }
}
