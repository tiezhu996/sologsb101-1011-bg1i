/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（测站 → 断面 → 垂线 → 测点 → 点据 → 绳套曲线 → 比测）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 *
 * v3 起支持可追溯绳套定线：
 * - 关系点据登记来源断面 / 垂线 / 测点与流量快照（ratings）
 * - 每测站 × 定线号维护版本化的涨 / 退水绳套曲线（ratingCurves）
 * - 复核批次（reviewBatches）实现「旧曲线失效 → 分支试算 → 确认 / 回滚」
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating, TrendDirection } from '@/types/rating'
import type { RatingCurve } from '@/types/curve'
import type { ReviewBatch } from '@/types/review'
import type { Compare } from '@/types/compare'
import { DEFAULT_WEIGHTS } from '@/utils/flow'
import { buildProvenanceSnapshot, inferDirections, type StageSeriesEntry } from '@/utils/provenance'
import { buildRatingCurve, rebuildComparesForCurves } from '@/utils/curveOps'

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
    this.version(2).stores({
      stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
      sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
      verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
      points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
      ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
      compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
    })

    // v3：可追溯绳套定线 —— 点据来源 / 快照 / 方向 / 状态，版本化曲线与复核批次
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings:
          'id, stationId, lineNo, stageM, flowM3s, measuredAt, status, direction, sourceSectionId, reviewBatchId, updatedAt',
        ratingCurves: 'id, stationId, lineNo, status, version, updatedAt',
        reviewBatches: 'id, stationId, lineNo, status, updatedAt',
        compares: 'id, ratingId, curveId, verdict, deviationPct, comparedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // v2 → v3：历史数据补齐时间戳、来源、方向；缺来源或方向不明的点据留在待确认
        const now = Date.now()
        const stampDefaults: Array<[string, (row: Record<string, unknown>) => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', (row) => (typeof row.measuredAt === 'string' ? {} : { measuredAt: new Date(now).toISOString() })],
          ['verticals', (row) => ({
            ...(typeof row.pointCount === 'number' ? {} : { pointCount: 0 }),
            ...(typeof row.bedNote === 'string' ? {} : { bedNote: '' })
          })],
          ['points', (row) => ({
            ...(typeof row.weight === 'number' ? {} : { weight: DEFAULT_WEIGHTS[1] }),
            ...(typeof row.durationS === 'number' ? {} : { durationS: 100 })
          })],
          // 只补缺失字段，绝不能覆盖历史点据已有的 measureNo / lineNo（否则来源匹配会丢失）
          ['ratings', (row) => ({
            ...(typeof row.measureNo === 'string' ? {} : { measureNo: '' }),
            ...(typeof row.lineNo === 'string' ? {} : { lineNo: 'A' })
          })],
          ['compares', (row) => ({
            ...(typeof row.operator === 'string' ? {} : { operator: '' }),
            ...(typeof row.comparedAt === 'string' ? {} : { comparedAt: new Date(now).toISOString() })
          })]
        ]
        for (const [tableName, defaultsFor] of stampDefaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, defaultsFor(row))
            })
        }

        const sections = await tx.table<Section, string>('sections').toArray()
        const verticals = await tx.table<Vertical, string>('verticals').toArray()
        const points = await tx.table<Point, string>('points').toArray()
        const rawRatings = await tx.table<Rating, string>('ratings').toArray()

        // 同站测次号 → 断面，用于回填来源
        const sectionKey = (stationId: string, measureNo: string): string => `${stationId}::${measureNo}`
        const sectionByKey = new Map<string, Section>()
        sections.forEach((section) => sectionByKey.set(sectionKey(section.stationId, section.measureNo), section))

        // 逐测站按点据时间序列推断涨水 / 退水方向；序列首点无前序时，参照后一测次推断
        const directionByStation = new Map<string, Map<string, TrendDirection>>()
        const stationIds = Array.from(new Set(rawRatings.map((rating) => rating.stationId)))
        stationIds.forEach((stationId) => {
          const entries: StageSeriesEntry[] = rawRatings
            .filter((rating) => rating.stationId === stationId)
            .map((rating) => ({ measureKey: rating.id, measuredAt: rating.measuredAt, stageM: rating.stageM }))
            .sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt))
          const map = inferDirections(entries)
          if (entries.length >= 2 && map.get(entries[0].measureKey) === '不明') {
            const first = rawRatings.find((rating) => rating.id === entries[0].measureKey)
            const firstHasSource =
              typeof first?.measureNo === 'string' &&
              first.measureNo.length > 0 &&
              sectionByKey.has(`${stationId}::${first.measureNo}`)
            // 仅当首点有来源断面时才参照后一测次补方向；缺来源的点据保持「不明」留待确认
            if (firstHasSource) {
              map.set(
                entries[0].measureKey,
                entries[1].stageM > entries[0].stageM ? '涨水' : entries[1].stageM < entries[0].stageM ? '退水' : '不明'
              )
            }
          }
          directionByStation.set(stationId, map)
        })

        const upgradedRatings: Rating[] = rawRatings.map((legacy) => {
          const matchedSection =
            typeof legacy.measureNo === 'string' && legacy.measureNo.length > 0
              ? sectionByKey.get(sectionKey(legacy.stationId, legacy.measureNo))
              : undefined
          const direction = directionByStation.get(legacy.stationId)?.get(legacy.id) ?? '不明'
          const hasSource = Boolean(matchedSection)
          // 有来源断面且方向明确才能回到已确认；缺来源或方向不明留在待确认
          const status = hasSource && direction !== '不明' ? '已确认' : '待确认'
          return {
            ...legacy,
            sourceSectionId: matchedSection?.id ?? null,
            sourceVerticalIds: [],
            sourcePoints: [],
            snapshot: null,
            snapshotStale: false,
            direction,
            status,
            reviewBatchId: null,
            note: matchedSection ? '历史升级：已补来源与方向' : '历史升级：缺来源断面，留在待确认'
          }
        })

        // 能找到来源断面且有垂线成果的，补一份流量快照（不覆盖原水位 / 流量）
        const finalRatings = upgradedRatings.map((rating) => {
          const sectionId = rating.sourceSectionId
          if (!sectionId) return rating
          const section = sections.find((item) => item.id === sectionId)
          if (!section) return rating
          const sectionVerticals = verticals.filter((vertical) => vertical.sectionId === sectionId)
          if (sectionVerticals.length === 0) {
            return { ...rating, note: `${rating.note}；缺垂线测点明细，快照待补` }
          }
          const provenance = buildProvenanceSnapshot({ section, verticals, points }, new Date(now).toISOString())
          return {
            ...rating,
            sourceVerticalIds: provenance.sourceVerticalIds,
            sourcePoints: provenance.sourcePoints,
            snapshot: provenance.snapshot
          }
        })
        await tx.table<Rating, string>('ratings').clear()
        await tx.table<Rating, string>('ratings').bulkPut(finalRatings)

        // 按测站 × 定线号，用已确认点据生成 v1 已确认绳套曲线（涨 / 退两支分别拟合）
        const curves: RatingCurve[] = []
        const curveKeyOf = (stationId: string, lineNo: string): string => `${stationId}::${lineNo}`
        const keys = Array.from(
          new Set(finalRatings.filter((r) => r.status === '已确认').map((r) => curveKeyOf(r.stationId, r.lineNo)))
        )
        const iso = new Date(now).toISOString()
        keys.forEach((key, index) => {
          const [stationId, lineNo] = key.split('::')
          const curve = buildRatingCurve({
            id: `crv_upgrade_${index + 1}`,
            stationId,
            lineNo,
            version: 1,
            ratings: finalRatings,
            confirmedBy: '系统迁移',
            confirmedAt: iso,
            now
          })
          if (curve.ratingIds.length > 0) curves.push(curve)
        })
        if (curves.length > 0) await tx.table<RatingCurve, string>('ratingCurves').bulkPut(curves)

        // 已确认点据按曲线重算比测，并为历史比测补 curveId / 分支
        const legacyCompares = await tx.table<Compare, string>('compares').toArray()
        const rebuilt = rebuildComparesForCurves(finalRatings, curves, { now, keep: legacyCompares })
        const ratingById = new Map(finalRatings.map((rating) => [rating.id, rating]))
        const mergedCompares = legacyCompares.map((compare) => {
          const rating = ratingById.get(compare.ratingId)
          return {
            ...compare,
            curveId: rebuilt.find((item) => item.ratingId === compare.ratingId)?.curveId ?? null,
            branch: rating?.direction ?? '不明'
          }
        })
        // 以重算结果为准（同一 ratingId 去重），缺失的保留历史
        const rebuiltIds = new Set(rebuilt.map((item) => item.ratingId))
        const kept = mergedCompares.filter((compare) => !rebuiltIds.has(compare.ratingId))
        await tx.table<Compare, string>('compares').clear()
        await tx.table<Compare, string>('compares').bulkPut([...rebuilt, ...kept])
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

/** 点据播种规格：source 指向有垂线成果的断面时按成果拍快照，否则按 flowM3s 建简化快照 */
interface SeedRatingSpec {
  id: string
  stationId: string
  lineNo: string
  measureNo: string
  measuredAt: string
  direction: TrendDirection
  /** 有垂线成果的来源断面 id（按部分面积法拍真实快照）；null 表示手工流量 */
  sourceSectionId: string | null
  /** 手工 / 简化快照流量（无垂线明细时使用） */
  flowM3s: number
}

/**
 * 播种演示数据：3 个测站 → 多个断面测次 → 垂线 → 测点，
 * 关系点据带来源断面 / 垂线 / 测点与流量快照，青矶 B 线为含涨 / 退两支的绳套，
 * 白沙 C 线含超限点据。每站生成已确认的版本化绳套曲线与比测记录。
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
          id: 'sec_lh_2404',
          stationId: 'stn_lh01',
          measureNo: '2024-04-001',
          startDistanceM: 12.5,
          stageM: 4.01,
          method: '流速仪',
          measuredAt: '2024-04-08T08:00:00.000Z'
        },
        {
          id: 'sec_lh_2405',
          stationId: 'stn_lh01',
          measureNo: '2024-05-002',
          startDistanceM: 12.5,
          stageM: 4.52,
          method: '流速仪',
          measuredAt: '2024-05-16T08:00:00.000Z'
        },
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          stageM: 5.42,
          method: '流速仪',
          measuredAt: '2024-06-12T08:30:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          stageM: 6.15,
          method: 'ADCP',
          measuredAt: '2024-07-18T09:10:00.000Z'
        },
        {
          id: 'sec_lh_2408',
          stationId: 'stn_lh01',
          measureNo: '2024-08-006',
          startDistanceM: 12.5,
          stageM: 7.03,
          method: '流速仪',
          measuredAt: '2024-08-21T08:20:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.92, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.72, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.72, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.42, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 1.12, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 1.02, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.8, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 2.06, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.8, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.46, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        remark: '小河站，洪水绳套明显，涨退水分别定线'
      },
      sections: [
        {
          id: 'sec_qj_2403',
          stationId: 'stn_qj02',
          measureNo: '2024-03-001',
          startDistanceM: 4.2,
          stageM: 2.84,
          method: '浮标',
          measuredAt: '2024-03-12T07:30:00.000Z'
        },
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '浮标',
          measuredAt: '2024-05-22T07:50:00.000Z'
        },
        {
          id: 'sec_qj_2406',
          stationId: 'stn_qj02',
          measureNo: '2024-06-006',
          startDistanceM: 4.2,
          stageM: 4.36,
          method: '流速仪',
          measuredAt: '2024-06-28T08:30:00.000Z'
        },
        {
          id: 'sec_qj_2407',
          stationId: 'stn_qj02',
          measureNo: '2024-07-001',
          startDistanceM: 4.2,
          stageM: 3.72,
          method: '浮标',
          measuredAt: '2024-07-20T08:10:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '流速仪',
          measuredAt: '2024-08-09T06:40:00.000Z'
        },
        {
          id: 'sec_qj_2408b',
          stationId: 'stn_qj02',
          measureNo: '2024-08-009',
          startDistanceM: 4.2,
          stageM: 4.02,
          method: '流速仪',
          measuredAt: '2024-08-12T07:20:00.000Z'
        },
        {
          id: 'sec_qj_2409',
          stationId: 'stn_qj02',
          measureNo: '2024-09-002',
          startDistanceM: 4.2,
          stageM: 2.84,
          method: '浮标',
          measuredAt: '2024-09-02T07:10:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 2.6, pointCount: 2, bedNote: '涨水浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 3.6, pointCount: 2, bedNote: '涨水中泓' },
        { id: 'vrt_qj_5', sectionId: 'sec_qj_2406', no: 1, startDistanceM: 3.1, depthM: 3.2, pointCount: 3, bedNote: '洪峰涨水期，流速仪三点法' },
        { id: 'vrt_qj_6', sectionId: 'sec_qj_2406', no: 2, startDistanceM: 7.6, depthM: 4.2, pointCount: 3, bedNote: '涨水主槽，卵石夹砂' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 2.2, pointCount: 3, bedNote: '退水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 3.0, pointCount: 3, bedNote: '退水主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.92, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.76, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 1.32, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 1.06, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_51', verticalId: 'vrt_qj_5', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_52', verticalId: 'vrt_qj_5', relativeDepth: 0.6, velocityMs: 1.58, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_53', verticalId: 'vrt_qj_5', relativeDepth: 0.8, velocityMs: 1.3, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_61', verticalId: 'vrt_qj_6', relativeDepth: 0.2, velocityMs: 2.12, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_62', verticalId: 'vrt_qj_6', relativeDepth: 0.6, velocityMs: 1.82, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_63', verticalId: 'vrt_qj_6', relativeDepth: 0.8, velocityMs: 1.5, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.04, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.88, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.72, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.26, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 100 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        remark: '巡测断面，与龙门站比测，C 线含超限点据'
      },
      sections: [
        {
          id: 'sec_bs_2405',
          stationId: 'stn_bs03',
          measureNo: '2024-05-004',
          startDistanceM: 18.0,
          stageM: 4.9,
          method: 'ADCP',
          measuredAt: '2024-05-28T09:00:00.000Z'
        },
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          stageM: 5.36,
          method: 'ADCP',
          measuredAt: '2024-06-20T10:05:00.000Z'
        },
        {
          id: 'sec_bs_2407',
          stationId: 'stn_bs03',
          measureNo: '2024-07-007',
          startDistanceM: 18.0,
          stageM: 5.88,
          method: '流速仪',
          measuredAt: '2024-07-25T09:30:00.000Z'
        },
        {
          id: 'sec_bs_2408',
          stationId: 'stn_bs03',
          measureNo: '2024-08-008',
          startDistanceM: 18.0,
          stageM: 6.44,
          method: '流速仪',
          measuredAt: '2024-08-15T09:40:00.000Z'
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

  // 关系点据：A 线龙门（涨水为主）、B 线青矶（涨 / 退绳套）、C 线白沙（含超限）
  const ratingSpecs: SeedRatingSpec[] = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z', direction: '涨水', sourceSectionId: 'sec_lh_2404', flowM3s: 97.5 },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z', direction: '涨水', sourceSectionId: 'sec_lh_2405', flowM3s: 138.7 },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z', direction: '涨水', sourceSectionId: 'sec_lh_2406', flowM3s: 217.2 },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z', direction: '涨水', sourceSectionId: 'sec_lh_2407', flowM3s: 298.5 },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z', direction: '涨水', sourceSectionId: 'sec_lh_2408', flowM3s: 428.1 },

    // B 线绳套：涨水支 2.84/3.18/4.36，退水支 4.02/3.72/3.18/2.84；同水位涨水流量偏大，两支单调不交叉
    { id: 'rat_qj_b1', stationId: 'stn_qj02', lineNo: 'B', measureNo: '2024-03-001', measuredAt: '2024-03-12T07:30:00.000Z', direction: '涨水', sourceSectionId: 'sec_qj_2403', flowM3s: 45.0 },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z', direction: '涨水', sourceSectionId: 'sec_qj_2405', flowM3s: 62.0 },
    { id: 'rat_qj_b5', stationId: 'stn_qj02', lineNo: 'B', measureNo: '2024-06-006', measuredAt: '2024-06-28T08:30:00.000Z', direction: '涨水', sourceSectionId: 'sec_qj_2406', flowM3s: 128.0 },
    { id: 'rat_qj_b8', stationId: 'stn_qj02', lineNo: 'B', measureNo: '2024-08-009', measuredAt: '2024-08-12T07:20:00.000Z', direction: '退水', sourceSectionId: 'sec_qj_2408b', flowM3s: 98.0 },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-20T08:10:00.000Z', direction: '退水', sourceSectionId: 'sec_qj_2407', flowM3s: 84.0 },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z', direction: '退水', sourceSectionId: 'sec_qj_2408', flowM3s: 57.0 },
    { id: 'rat_qj_b6', stationId: 'stn_qj02', lineNo: 'B', measureNo: '2024-09-002', measuredAt: '2024-09-02T07:10:00.000Z', direction: '退水', sourceSectionId: 'sec_qj_2409', flowM3s: 41.0 },

    // C 线：c3 / c4 偏离，用于演示超限挂红与偏差分析
    { id: 'rat_bs_c1', stationId: 'stn_bs03', lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z', direction: '涨水', sourceSectionId: 'sec_bs_2405', flowM3s: 168.0 },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z', direction: '涨水', sourceSectionId: 'sec_bs_2406', flowM3s: 205.0 },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z', direction: '涨水', sourceSectionId: 'sec_bs_2407', flowM3s: 325.0 },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z', direction: '涨水', sourceSectionId: 'sec_bs_2408', flowM3s: 288.0 }
  ]

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
      await db.sections.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
        )
      )
      await db.verticals.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        )
      )
      await db.points.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.points.map((point) => ({ ...point, ...stamp(point) }))
        )
      )

      // 汇总断面 / 垂线 / 测点，按来源为点据拍流量快照
      const allSections = stationBundles.flatMap((bundle) => bundle.sections)
      const allVerticals = stationBundles.flatMap((bundle) => bundle.verticals)
      const allPoints = stationBundles.flatMap((bundle) => bundle.points)
      const verticalsBySection = new Map<string, number>()
      allVerticals.forEach((vertical) =>
        verticalsBySection.set(vertical.sectionId, (verticalsBySection.get(vertical.sectionId) ?? 0) + 1)
      )

      const ratings: Rating[] = ratingSpecs.map((spec, index) => {
        const section = allSections.find((item) => item.id === spec.sourceSectionId)
        const hasDetails = section ? (verticalsBySection.get(section.id) ?? 0) > 0 : false
        const provenance =
          section && hasDetails
            ? buildProvenanceSnapshot(
                {
                  section: { ...section, ...stamp(section) },
                  verticals: allVerticals
                    .filter((vertical) => vertical.sectionId === section.id)
                    .map((vertical) => ({ ...vertical, ...stamp(vertical) })),
                  points: allPoints
                    .filter((point) =>
                      allVerticals.some(
                        (vertical) => vertical.sectionId === section.id && vertical.id === point.verticalId
                      )
                    )
                    .map((point) => ({ ...point, ...stamp(point) }))
                },
                spec.measuredAt
              )
            : null
        const stageM = provenance ? provenance.snapshot.stageM : section?.stageM ?? 0
        // 有垂线测点明细时指针按真实成果登记；整编点据的快照流量采用规格中的整编成果值，
        // 保证演示绳套涨 / 退两支水力学一致（实测断面数据为示意规模）。
        const flowM3s = provenance
          ? spec.flowM3s > 0
            ? spec.flowM3s
            : provenance.snapshot.flowM3s
          : spec.flowM3s
        const snapshot: Rating['snapshot'] = provenance
          ? {
              ...provenance.snapshot,
              flowM3s,
              meanVelocityMs: provenance.snapshot.areaM2 > 0 ? Number((flowM3s / provenance.snapshot.areaM2).toFixed(3)) : provenance.snapshot.meanVelocityMs
            }
          : section
            ? {
                stageM: section.stageM,
                flowM3s: spec.flowM3s,
                areaM2: 0,
                meanVelocityMs: 0,
                verticalCount: 0,
                pointCount: 0,
                capturedAt: spec.measuredAt,
                sourceUpdatedAt: now + section.id.length
              }
            : null
        return {
          id: spec.id,
          stationId: spec.stationId,
          stageM,
          flowM3s,
          lineNo: spec.lineNo,
          measureNo: spec.measureNo,
          measuredAt: spec.measuredAt,
          sourceSectionId: section?.id ?? null,
          sourceVerticalIds: provenance?.sourceVerticalIds ?? [],
          sourcePoints: provenance?.sourcePoints ?? [],
          snapshot,
          snapshotStale: false,
          direction: spec.direction,
          status: '已确认',
          reviewBatchId: null,
          note: provenance
            ? spec.flowM3s > 0
              ? '来源测验成果完整（快照采用整编成果值）'
              : '来源测验成果完整'
            : '历史整编点据，缺垂线测点明细',
          createdAt: now + index,
          updatedAt: now + index
        }
      })
      await db.ratings.bulkPut(ratings)

      // 每站 × 线号一条 v1 已确认绳套曲线
      const curveKeys = Array.from(new Set(ratings.map((rating) => `${rating.stationId}::${rating.lineNo}`)))
      const curves: RatingCurve[] = curveKeys.map((key, index) => {
        const [stationId, lineNo] = key.split('::')
        return buildRatingCurve({
          id: `crv_seed_${index + 1}`,
          stationId,
          lineNo,
          version: 1,
          ratings,
          confirmedBy: '林昭',
          confirmedAt: iso,
          now
        })
      })
      await db.ratingCurves.bulkPut(curves)

      // 已确认点据按曲线生成比测记录（C 线超限点据在此被判定）
      const compares: Compare[] = rebuildComparesForCurves(ratings, curves, {
        now,
        operator: '林昭'
      })
      await db.compares.bulkPut(compares)
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

/** 全部业务表名（清空 / 统计 / 导入事务共用） */
export const ALL_TABLES = [
  'stations',
  'sections',
  'verticals',
  'points',
  'ratings',
  'ratingCurves',
  'reviewBatches',
  'compares'
] as const

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
  const [stations, sections, verticals, points, ratings, ratingCurves, reviewBatches, compares] =
    await Promise.all([
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
export { calcMeanVelocity as verticalMeanVelocity } from '@/utils/flow'
