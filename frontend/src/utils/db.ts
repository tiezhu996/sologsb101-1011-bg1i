/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（测站 → 断面 → 垂线 → 测点 → 点据 → 比测）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating } from '@/types/rating'
import type { RatingCurve } from '@/types/ratingCurve'
import type { ReviewBatch } from '@/types/review'
import type { Compare } from '@/types/compare'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { curveFlow, fitPowerCurve } from '@/types/rating'
import { calcMeanVelocity, DEFAULT_WEIGHTS, round } from '@/utils/flow'
import { buildRatingSourceSnapshot } from '@/utils/ratingSource'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  ratingCurves: RatingCurve[]
  reviewBatches: ReviewBatch[]
  compares: Compare[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  ratingCurves!: Table<RatingCurve, string>
  reviewBatches!: Table<ReviewBatch, string>
  compares!: Table<Compare, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })

    // v2：补齐筛选与统计需要的索引（河名/集水面积、水位、测法、偏差判定）
    this.version(2)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与判定结论，避免列表排序与筛选拿到 undefined
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', () => ({ measuredAt: new Date().toISOString() })],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
          ['ratings', () => ({ measureNo: '', lineNo: 'A' })],
          ['compares', () => ({ operator: '', comparedAt: new Date().toISOString() })]
        ]
        for (const [tableName, defaults] of stamps) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, defaults())
            })
        }
      })

    // v3：增加绳套曲线版本与复核批次；历史点据补来源和方向，缺项保留待确认。
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, trend, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings:
          'id, stationId, lineNo, direction, status, stageM, flowM3s, measureNo, measuredAt, updatedAt',
        ratingCurves:
          'id, stationId, [stationId+lineNo], lineNo, branch, version, status, confirmedAt',
        reviewBatches: 'id, stationId, [stationId+lineNo], lineNo, status, reviewedAt',
        compares: 'id, ratingId, curveId, verdict, deviationPct, comparedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        const sections = await tx.table<Section, string>('sections').toArray()
        const verticals = await tx.table<Vertical, string>('verticals').toArray()
        const points = await tx.table<Point, string>('points').toArray()
        await tx.table('sections').toCollection().modify((section: Section) => {
          if (section.trend === '涨水' || section.trend === '退水') return
          const notes = verticals
            .filter((vertical) => vertical.sectionId === section.id)
            .map((vertical) => vertical.bedNote)
            .join(' ')
          if (notes.includes('涨水')) section.trend = '涨水'
          else if (notes.includes('退水')) section.trend = '退水'
          else section.trend = '未知'
        })
        await tx.table('ratings').toCollection().modify((rating: Rating) => {
          const section = sections.find(
            (item) => item.measureNo === rating.measureNo && item.stationId === rating.stationId
          )
          const direction = section?.trend === '涨水' || section?.trend === '退水' ? section.trend : '未知'
          rating.direction = direction
          rating.status = 'pending'
          rating.sourceRef = section ? { sectionId: section.id } : null
          if (section) {
            const relatedVerticals = verticals.filter((vertical) => vertical.sectionId === section.id)
            const relatedPoints = points.filter((point) =>
              relatedVerticals.some((vertical) => vertical.id === point.verticalId)
            )
            rating.sourceSnapshot = buildRatingSourceSnapshot(section, relatedVerticals, relatedPoints)
            rating.sourceSnapshotAt = Date.now()
          } else {
            rating.sourceSnapshot = null
          }
          rating.staleReason = ''
          rating.confirmedCurveId = null
          rating.confirmedAt = null
        })
        await tx.table('compares').toCollection().modify((compare: Compare) => {
          compare.curveId = null
          compare.branch = '未知'
          compare.lineNo = ''
        })
      })
  }
}

export const db = new HydroGaugeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedStationBundle {
  station: Omit<Station, 'createdAt' | 'updatedAt'>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
}

/**
 * 播种演示数据：3 个测站 → 4 个断面测次 → 8 条垂线 → 16 个流速测点，
 * 并据此生成水位流量关系点据与比测记录，保证父 → 子 → 孙三层链路可点开。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      sections: [
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          stageM: 5.42,
          method: '流速仪',
          trend: '涨水',
          measuredAt: '2024-06-12T08:30:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          stageM: 6.15,
          method: 'ADCP',
          trend: '退水',
          measuredAt: '2024-07-18T09:10:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.62, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.48, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.42, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.18, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 0.96, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 0.82, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.64, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.64, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.32, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      sections: [
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '浮标',
          trend: '退水',
          measuredAt: '2024-05-22T07:50:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          stageM: 4.36,
          method: '流速仪',
          trend: '涨水',
          measuredAt: '2024-08-09T06:40:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.54, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.42, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 0.88, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 0.7, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.06, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.92, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.78, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.34, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.2, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 1.04, weight: 1 / 3, durationS: 100 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        remark: '巡测断面，与龙门站比测'
      },
      sections: [
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          stageM: 5.36,
          method: 'ADCP',
          trend: '涨水',
          measuredAt: '2024-06-20T10:05:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面' },
        { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面' }
      ],
      points: [
        { id: 'pnt_bs_11', verticalId: 'vrt_bs_1', relativeDepth: 0.2, velocityMs: 1.22, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_12', verticalId: 'vrt_bs_1', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_13', verticalId: 'vrt_bs_1', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_21', verticalId: 'vrt_bs_2', relativeDepth: 0.2, velocityMs: 1.46, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_22', verticalId: 'vrt_bs_2', relativeDepth: 0.6, velocityMs: 1.3, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_23', verticalId: 'vrt_bs_2', relativeDepth: 0.8, velocityMs: 1.1, weight: 1 / 3, durationS: 120 }
      ]
    }
  ]

  // 水位流量关系点据：A/B/C 线均包含涨水、退水两个绳套分支
  const ratingInput: Array<
    Omit<Rating, 'createdAt' | 'updatedAt' | 'direction' | 'status' | 'sourceRef' | 'sourceSnapshot' | 'sourceSnapshotAt' | 'staleReason' | 'confirmedCurveId' | 'confirmedAt'> & {
      direction?: Rating['direction']
    }
  > = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z', direction: '涨水' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z', direction: '涨水' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z', direction: '涨水' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 330.0, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z', direction: '退水' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z', direction: '退水' },
    { id: 'rat_lh_a6', stationId: 'stn_lh01', stageM: 6.64, flowM3s: 362.0, lineNo: 'A', measureNo: '2024-08-007', measuredAt: '2024-08-18T08:20:00.000Z', direction: '涨水' },
    { id: 'rat_lh_a7', stationId: 'stn_lh01', stageM: 5.88, flowM3s: 285.0, lineNo: 'A', measureNo: '2024-07-003', measuredAt: '2024-07-20T09:10:00.000Z', direction: '退水' },
    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z', direction: '涨水' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 63.0, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z', direction: '退水' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 91.0, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z', direction: '退水' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z', direction: '涨水' },
    { id: 'rat_qj_b5', stationId: 'stn_qj02', stageM: 3.88, flowM3s: 88.2, lineNo: 'B', measureNo: '2024-08-005', measuredAt: '2024-08-07T06:40:00.000Z', direction: '涨水' },
    { id: 'rat_qj_b6', stationId: 'stn_qj02', stageM: 3.45, flowM3s: 76.0, lineNo: 'B', measureNo: '2024-07-002', measuredAt: '2024-07-04T08:10:00.000Z', direction: '退水' },
    // C 线：含一个明显偏离点，用于复核后比测超限分析
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z', direction: '涨水' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z', direction: '涨水' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 292.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z', direction: '涨水' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 390.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z', direction: '退水' },
    { id: 'rat_bs_c5', stationId: 'stn_bs03', stageM: 5.72, flowM3s: 282.0, lineNo: 'C', measureNo: '2024-08-009', measuredAt: '2024-08-13T09:40:00.000Z', direction: '退水' },
    { id: 'rat_bs_c6', stationId: 'stn_bs03', stageM: 5.08, flowM3s: 201.0, lineNo: 'C', measureNo: '2024-05-005', measuredAt: '2024-05-30T09:00:00.000Z', direction: '退水' }
  ]

  const existingSections = stationBundles.flatMap((bundle) => bundle.sections)
  const existingVerticals = stationBundles.flatMap((bundle) => bundle.verticals)
  const existingPoints = stationBundles.flatMap((bundle) => bundle.points)
  const sourceSections: Array<Omit<Section, 'createdAt' | 'updatedAt'>> = []
  const sourceVerticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>> = []
  const sourcePoints: Array<Omit<Point, 'createdAt' | 'updatedAt'>> = []

  ratingInput.forEach((rating, index) => {
    const meanSourceVelocity = Number(((0.7 + (index % 5) * 0.18 + 0.55 + (index % 5) * 0.16) / 2).toFixed(3))
    const section =
      existingSections.find((item) => item.stationId === rating.stationId && item.measureNo === rating.measureNo) ??
      sourceSections.find((item) => item.stationId === rating.stationId && item.measureNo === rating.measureNo)
    if (!section) {
      sourceSections.push({
        id: `sec_src_${rating.id}`,
        stationId: rating.stationId,
        measureNo: rating.measureNo,
        startDistanceM: 4.2,
        stageM: rating.stageM,
        method: '流速仪',
        trend: rating.direction ?? '涨水',
        measuredAt: rating.measuredAt
      })
    }
    const targetSection = section ?? sourceSections[sourceSections.length - 1]
    const hasVertical = [...existingVerticals, ...sourceVerticals].some((vertical) => vertical.sectionId === targetSection.id)
    if (!hasVertical) {
      sourceVerticals.push({
        id: `vrt_src_${rating.id}`,
        sectionId: targetSection.id,
        no: 1,
        startDistanceM: 2 + (index % 8),
        depthM: Number((rating.flowM3s / Math.max(meanSourceVelocity * 4, 0.1)).toFixed(2)),
        pointCount: 2,
        bedNote: `${rating.direction ?? '涨水'}分支来源垂线快照`
      })
      sourcePoints.push(
        {
          id: `pnt_src_${rating.id}_1`,
          verticalId: `vrt_src_${rating.id}`,
          relativeDepth: 0.2,
          velocityMs: Number((0.7 + (index % 5) * 0.18).toFixed(2)),
          weight: 0.5,
          durationS: 100
        },
        {
          id: `pnt_src_${rating.id}_2`,
          verticalId: `vrt_src_${rating.id}`,
          relativeDepth: 0.8,
          velocityMs: Number((0.55 + (index % 5) * 0.16).toFixed(2)),
          weight: 0.5,
          durationS: 100
        }
      )
    }
  })

  const allSeedSections = [...existingSections, ...sourceSections]
  const allSeedVerticals = [...existingVerticals, ...sourceVerticals]
  const allSeedPoints = [...existingPoints, ...sourcePoints]
  const ratingSeeds: Rating[] = ratingInput.map((rating, index) => {
    const section = allSeedSections.find(
      (item) => item.stationId === rating.stationId && item.measureNo === rating.measureNo
    )
    const verticals = allSeedVerticals.filter((item) => item.sectionId === section?.id)
    const points = allSeedPoints.filter((point) => verticals.some((vertical) => vertical.id === point.verticalId))
    const snapshot = section ? buildRatingSourceSnapshot(section, verticals, points) : null
    const usesExistingSection = Boolean(section && existingSections.some((item) => item.id === section.id))
    if (usesExistingSection && snapshot?.flow) snapshot.flow.flowM3s = rating.flowM3s
    return {
      ...rating,
      direction: rating.direction ?? '涨水',
      status: 'confirmed',
      sourceRef: section ? { sectionId: section.id, verticalId: verticals[0]?.id, pointId: points[0]?.id } : null,
      sourceSnapshot: snapshot,
      sourceSnapshotAt: now,
      staleReason: '',
      confirmedCurveId: null,
      confirmedAt: null,
      createdAt: now + index,
      updatedAt: now + index
    }
  })

  await db.transaction(
    'rw',
    [
      db.stations,
      db.sections,
      db.verticals,
      db.points,
      db.ratings,
      db.ratingCurves,
      db.reviewBatches,
      db.compares
    ],
    async () => {
      const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
        createdAt: now + row.id.length,
        updatedAt: now + row.id.length
      })

      await db.stations.bulkPut(
        stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) }))
      )
      await db.sections.bulkPut([
        ...stationBundles.flatMap((bundle) =>
          bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
        ),
        ...sourceSections.map((section) => ({ ...section, ...stamp(section) }))
      ])
      await db.verticals.bulkPut([
        ...stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        ),
        ...sourceVerticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
      ])
      await db.points.bulkPut([
        ...stationBundles.flatMap((bundle) =>
          bundle.points.map((point) => ({ ...point, ...stamp(point) }))
        ),
        ...sourcePoints.map((point) => ({ ...point, ...stamp(point) }))
      ])
      await db.ratings.bulkPut(ratingSeeds)

      // 已确认绳套曲线：按定线号 + 涨水/退水分支拟合，并生成不可覆盖的版本与比测记录。
      const curves: RatingCurve[] = []
      const compares: Compare[] = []
      const lineKeys = Array.from(new Set(ratingSeeds.map((rating) => rating.lineNo)))
      lineKeys.forEach((lineNo) => {
        ;(['涨水', '退水'] as const).forEach((branch) => {
          const branchRatings = ratingSeeds.filter(
            (rating) => rating.lineNo === lineNo && rating.direction === branch
          )
          const fit = fitPowerCurve(
            branchRatings.map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
            lineNo,
            branch
          )
          if (!fit.valid) return
          const curve: RatingCurve = {
            id: `crv_${lineNo.toLowerCase()}_${branch === '涨水' ? 'rise' : 'fall'}`,
            stationId: branchRatings[0]?.stationId ?? '',
            lineNo,
            branch,
            version: 1,
            status: 'confirmed',
            fit,
            ratingIds: branchRatings.map((rating) => rating.id),
            previousCurveId: null,
            supersededByCurveId: null,
            reviewBatchId: 'rb_seed',
            reviewNote: `演示数据${lineNo}线${branch}分支`,
            confirmedBy: '林昭',
            confirmedAt: now,
            createdAt: now,
            updatedAt: now
          }
          curves.push(curve)
          branchRatings.forEach((rating) => {
            rating.confirmedCurveId = curve.id
            rating.confirmedAt = now
          })
        })
      })
      ratingSeeds.forEach((rating) => {
        const curve = curves.find((item) => item.id === rating.confirmedCurveId)
        if (!curve) return
        const predicted = curveFlow(curve.fit, rating.stageM)
        const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
        compares.push({
          id: `cmp_${rating.id}`,
          ratingId: rating.id,
          curveId: curve.id,
          branch: curve.branch,
          lineNo: curve.lineNo,
          measuredFlow: rating.flowM3s,
          curveFlow: predicted,
          deviationPct,
          verdict: judgeDeviation(deviationPct),
          operator: rating.lineNo === 'C' ? '周渝' : '林昭',
          comparedAt: rating.measuredAt,
          createdAt: now,
          updatedAt: now
        })
      })
      await db.ratings.bulkPut(ratingSeeds)
      await db.ratingCurves.bulkPut(curves)
      await db.reviewBatches.put({
        id: 'rb_seed',
        stationId: '*',
        lineNo: '*',
        status: 'success',
        conflictCount: 0,
        errors: [],
        beforeRatings: ratingSeeds,
        beforeCurves: curves,
        beforeCompares: compares,
        afterRatings: ratingSeeds,
        afterCurves: curves,
        afterCompares: compares,
        confirmedCurveIds: curves.map((curve) => curve.id),
        reviewedAt: now,
        createdAt: now,
        updatedAt: now
      })
      await db.compares.bulkPut(compares)
      if (compares.length === 0) {
        await db.compares.put({
          id: 'cmp_fallback',
          ratingId: 'rat_lh_a1',
          measuredFlow: 97.5,
          curveFlow: 100.2,
          deviationPct: calcDeviationPct(97.5, 100.2),
          verdict: judgeDeviation(calcDeviationPct(97.5, 100.2)),
          operator: '林昭',
          comparedAt: iso,
          createdAt: now,
          updatedAt: now
        })
      }
    }
  )
}

/** 打开数据库并幂等播种：仅当测站表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.stations.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.stations,
      db.sections,
      db.verticals,
      db.points,
      db.ratings,
      db.ratingCurves,
      db.reviewBatches,
      db.compares
    ],
    async () => {
      await Promise.all([
        db.stations.clear(),
        db.sections.clear(),
        db.verticals.clear(),
        db.points.clear(),
        db.ratings.clear(),
        db.ratingCurves.clear(),
        db.reviewBatches.clear(),
        db.compares.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [stations, sections, verticals, points, ratings, ratingCurves, reviewBatches, compares] = await Promise.all([
    db.stations.count(),
    db.sections.count(),
    db.verticals.count(),
    db.points.count(),
    db.ratings.count(),
    db.ratingCurves.count(),
    db.reviewBatches.count(),
    db.compares.count()
  ])
  return { stations, sections, verticals, points, ratings, ratingCurves, reviewBatches, compares }
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面与播种共用同一套算法） */
export function verticalMeanVelocity(points: Point[]): number {
  return calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}
