import type { Point } from '@/types/point'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import {
  pointToSnapshot,
  sectionToSnapshot,
  verticalToSnapshot,
  type RatingSourceSnapshot
} from '@/types/ratingSource'
import { calcMeanVelocity, calcSectionDischarge } from '@/utils/flow'

/** 按当前断面、垂线与测点生成不可直接覆盖的关系点据来源快照 */
export function buildRatingSourceSnapshot(
  section: Omit<Section, 'createdAt' | 'updatedAt'>,
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>,
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
): RatingSourceSnapshot {
  const ordered = [...verticals].sort((a, b) => a.startDistanceM - b.startDistanceM)
  const slices = ordered.map((vertical) => {
    const rowPoints = points.filter((point) => point.verticalId === vertical.id)
    return {
      id: vertical.id,
      no: vertical.no,
      startDistanceM: vertical.startDistanceM,
      depthM: vertical.depthM,
      meanVelocityMs: calcMeanVelocity(rowPoints.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
    }
  })
  return {
    section: sectionToSnapshot(section),
    verticals: ordered.map(verticalToSnapshot),
    points: points
      .filter((point) => verticals.some((vertical) => vertical.id === point.verticalId))
      .map(pointToSnapshot),
    flow: calcSectionDischarge(slices),
    capturedAt: Date.now()
  }
}
