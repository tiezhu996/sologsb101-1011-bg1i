/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入。
 * 与 utils/db.ts 的 BackupPayload 结构保持一致。
 * v3 起携带关系点据来源 / 快照 / 方向 / 状态、绳套曲线版本与复核批次；
 * 导入 v1/v2 旧备份时自动补齐这些字段（缺来源 / 方向不明的点据留在待确认）。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import type { Rating } from '@/types/rating'
import type { RatingCurve } from '@/types/curve'
import type { ReviewBatch } from '@/types/review'
import type { Compare } from '@/types/compare'

/** 备份集合键名（v3 共八张表） */
export const BACKUP_KEYS = [
  'stations',
  'sections',
  'verticals',
  'points',
  'ratings',
  'ratingCurves',
  'reviewBatches',
  'compares'
] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

/** 各表行数统计（导出页展示与导入结果回执共用） */
export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照（状态随记录一并导出） */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [stations, sections, verticals, points, ratings, ratingCurves, reviewBatches, compares] =
    await Promise.all([
      db.stations.toArray(),
      db.sections.toArray(),
      db.verticals.toArray(),
      db.points.toArray(),
      db.ratings.toArray(),
      db.ratingCurves.toArray(),
      db.reviewBatches.toArray(),
      db.compares.toArray()
    ])
  return {
    app: 'gbhydrogaug',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations,
    sections,
    verticals,
    points,
    ratings,
    ratingCurves,
    reviewBatches,
    compares
  }
}

/** 把旧版本（v1/v2）点据归一化到 v3 结构：缺来源 / 方向不明留在待确认 */
function normalizeRating(raw: Record<string, unknown>): Rating {
  const direction = raw.direction === '涨水' || raw.direction === '退水' ? raw.direction : '不明'
  const hasSource = typeof raw.sourceSectionId === 'string' && raw.sourceSectionId.length > 0
  const explicitStatus = raw.status === '已确认' || raw.status === '待确认' || raw.status === '待复核'
  const status = explicitStatus
    ? (raw.status as Rating['status'])
    : hasSource && direction !== '不明'
      ? '已确认'
      : '待确认'
  return {
    id: String(raw.id ?? createId('rat')),
    stationId: String(raw.stationId ?? ''),
    stageM: Number(raw.stageM ?? 0),
    flowM3s: Number(raw.flowM3s ?? 0),
    lineNo: String(raw.lineNo ?? 'A'),
    measureNo: String(raw.measureNo ?? ''),
    measuredAt: typeof raw.measuredAt === 'string' ? raw.measuredAt : new Date().toISOString(),
    sourceSectionId: hasSource ? String(raw.sourceSectionId) : null,
    sourceVerticalIds: Array.isArray(raw.sourceVerticalIds)
      ? (raw.sourceVerticalIds as string[]).map(String)
      : [],
    sourcePoints: Array.isArray(raw.sourcePoints) ? (raw.sourcePoints as Rating['sourcePoints']) : [],
    snapshot:
      raw.snapshot && typeof raw.snapshot === 'object' ? (raw.snapshot as Rating['snapshot']) : null,
    snapshotStale: raw.snapshotStale === true,
    direction,
    status,
    reviewBatchId: typeof raw.reviewBatchId === 'string' ? String(raw.reviewBatchId) : null,
    note: typeof raw.note === 'string' ? raw.note : '导入旧版备份：溯源信息缺失，待确认',
    createdAt: Number(raw.createdAt ?? Date.now()),
    updatedAt: Number(raw.updatedAt ?? raw.createdAt ?? Date.now())
  }
}

/** 归一化绳套曲线（旧备份没有该表，缺省空数组） */
function normalizeCurve(raw: Record<string, unknown>): RatingCurve {
  return {
    id: String(raw.id ?? createId('crv')),
    stationId: String(raw.stationId ?? ''),
    lineNo: String(raw.lineNo ?? 'A'),
    version: Number(raw.version ?? 1),
    status: raw.status === '已失效' ? '已失效' : '已确认',
    risingBranch: (raw.risingBranch as RatingCurve['risingBranch']) ?? null,
    fallingBranch: (raw.fallingBranch as RatingCurve['fallingBranch']) ?? null,
    stageMinM: Number(raw.stageMinM ?? 0),
    stageMaxM: Number(raw.stageMaxM ?? 0),
    ratingIds: Array.isArray(raw.ratingIds) ? (raw.ratingIds as string[]).map(String) : [],
    confirmedBy: String(raw.confirmedBy ?? ''),
    confirmedAt: typeof raw.confirmedAt === 'string' ? raw.confirmedAt : new Date().toISOString(),
    invalidatedAt: typeof raw.invalidatedAt === 'string' ? raw.invalidatedAt : null,
    invalidateReason: String(raw.invalidateReason ?? ''),
    supersededByCurveId:
      typeof raw.supersededByCurveId === 'string' ? String(raw.supersededByCurveId) : null,
    reviewBatchId: typeof raw.reviewBatchId === 'string' ? String(raw.reviewBatchId) : null,
    createdAt: Number(raw.createdAt ?? Date.now()),
    updatedAt: Number(raw.updatedAt ?? Date.now())
  }
}

/** 归一化复核批次 */
function normalizeBatch(raw: Record<string, unknown>): ReviewBatch {
  const status =
    raw.status === '已确认' || raw.status === '已回滚' ? raw.status : '进行中'
  return {
    id: String(raw.id ?? createId('rvw')),
    stationId: String(raw.stationId ?? ''),
    lineNo: String(raw.lineNo ?? 'A'),
    status,
    items: Array.isArray(raw.items) ? (raw.items as ReviewBatch['items']) : [],
    baselineCurveId:
      typeof raw.baselineCurveId === 'string' ? String(raw.baselineCurveId) : null,
    rollback:
      raw.rollback && typeof raw.rollback === 'object'
        ? (raw.rollback as ReviewBatch['rollback'])
        : {},
    touchedCurveIds: Array.isArray(raw.touchedCurveIds)
      ? (raw.touchedCurveIds as string[]).map(String)
      : [],
    risingFit: (raw.risingFit as ReviewBatch['risingFit']) ?? null,
    fallingFit: (raw.fallingFit as ReviewBatch['fallingFit']) ?? null,
    conflicts: Array.isArray(raw.conflicts) ? (raw.conflicts as ReviewBatch['conflicts']) : [],
    message: String(raw.message ?? ''),
    operator: String(raw.operator ?? ''),
    createdAt: Number(raw.createdAt ?? Date.now()),
    updatedAt: Number(raw.updatedAt ?? Date.now()),
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null
  }
}

/** 归一化比测记录：旧版补 curveId 与分支 */
function normalizeCompare(raw: Record<string, unknown>): Compare {
  const branch = raw.branch === '涨水' || raw.branch === '退水' ? raw.branch : '不明'
  return {
    id: String(raw.id ?? createId('cmp')),
    ratingId: String(raw.ratingId ?? ''),
    curveId: typeof raw.curveId === 'string' ? String(raw.curveId) : null,
    branch,
    measuredFlow: Number(raw.measuredFlow ?? 0),
    curveFlow: Number(raw.curveFlow ?? 0),
    deviationPct: Number(raw.deviationPct ?? 0),
    verdict: raw.verdict === '超限' ? '超限' : '合格',
    operator: String(raw.operator ?? ''),
    comparedAt: typeof raw.comparedAt === 'string' ? raw.comparedAt : new Date().toISOString(),
    createdAt: Number(raw.createdAt ?? Date.now()),
    updatedAt: Number(raw.updatedAt ?? Date.now())
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件，并归一化到当前结构版本 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload> & Record<string, unknown>
  if (obj.app !== 'gbhydrogaug' && obj.app !== undefined) {
    errors.push('app 字段应为 gbhydrogaug，文件来源不明')
  }
  // v1/v2 必备的六张表；v3 新增两张表缺省时按空数组处理
  for (const key of ['stations', 'sections', 'verticals', 'points', 'ratings', 'compares'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }

  const ratings = (obj.ratings as unknown as Array<Record<string, unknown>>).map(normalizeRating)
  const ratingCurves = Array.isArray(obj.ratingCurves)
    ? (obj.ratingCurves as unknown as Array<Record<string, unknown>>).map(normalizeCurve)
    : []
  const reviewBatches = Array.isArray(obj.reviewBatches)
    ? (obj.reviewBatches as unknown as Array<Record<string, unknown>>).map(normalizeBatch)
    : []
  const compares = (obj.compares as unknown as Array<Record<string, unknown>>).map(normalizeCompare)

  const payload: BackupPayload = {
    app: 'gbhydrogaug',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    stations: obj.stations ?? [],
    sections: obj.sections ?? [],
    verticals: obj.verticals ?? [],
    points: obj.points ?? [],
    ratings,
    ratingCurves,
    reviewBatches,
    compares
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    stations: payload.stations.length,
    sections: payload.sections.length,
    verticals: payload.verticals.length,
    points: payload.points.length,
    ratings: payload.ratings.length,
    ratingCurves: payload.ratingCurves.length,
    reviewBatches: payload.reviewBatches.length,
    compares: payload.compares.length
  }
}

/** 导出 JSON 文件到浏览器下载目录（曲线版本 / 复核状态随记录一并导出） */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
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
      await db.stations.bulkPut(payload.stations)
      await db.sections.bulkPut(payload.sections)
      await db.verticals.bulkPut(payload.verticals)
      await db.points.bulkPut(payload.points)
      await db.ratings.bulkPut(payload.ratings)
      await db.ratingCurves.bulkPut(payload.ratingCurves)
      await db.reviewBatches.bulkPut(payload.reviewBatches)
      await db.compares.bulkPut(payload.compares)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案；状态与溯源字段原样保留 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const stationMap = new Map<string, string>()
  const sectionMap = new Map<string, string>()
  const verticalMap = new Map<string, string>()
  const pointMap = new Map<string, string>()
  const ratingMap = new Map<string, string>()
  const curveMap = new Map<string, string>()
  const batchMap = new Map<string, string>()

  const stations = payload.stations.map((station) => {
    const id = createId('stn')
    stationMap.set(station.id, id)
    return { ...station, id }
  })
  const sections = payload.sections.map((section) => {
    const id = createId('sec')
    sectionMap.set(section.id, id)
    return { ...section, id, stationId: stationMap.get(section.stationId) ?? section.stationId }
  })
  const verticals = payload.verticals.map((vertical) => {
    const id = createId('vrt')
    verticalMap.set(vertical.id, id)
    return { ...vertical, id, sectionId: sectionMap.get(vertical.sectionId) ?? vertical.sectionId }
  })
  const points = payload.points.map((point) => {
    const id = createId('pnt')
    pointMap.set(point.id, id)
    return { ...point, id, verticalId: verticalMap.get(point.verticalId) ?? point.verticalId }
  })
  const ratings = payload.ratings.map((rating) => {
    const id = createId('rat')
    ratingMap.set(rating.id, id)
    return {
      ...rating,
      id,
      stationId: stationMap.get(rating.stationId) ?? rating.stationId,
      sourceSectionId: rating.sourceSectionId
        ? sectionMap.get(rating.sourceSectionId) ?? rating.sourceSectionId
        : null,
      sourceVerticalIds: rating.sourceVerticalIds.map(
        (verticalId) => verticalMap.get(verticalId) ?? verticalId
      ),
      sourcePoints: rating.sourcePoints.map((source) => ({
        ...source,
        pointId: pointMap.get(source.pointId) ?? source.pointId
      })),
      reviewBatchId: rating.reviewBatchId ? '(pending-batch)' : null
    }
  })
  const ratingCurves = payload.ratingCurves.map((curve) => {
    const id = createId('crv')
    curveMap.set(curve.id, id)
    const remapRatingId = (ratingId: string): string => ratingMap.get(ratingId) ?? ratingId
    return {
      ...curve,
      id,
      stationId: stationMap.get(curve.stationId) ?? curve.stationId,
      supersededByCurveId: curve.supersededByCurveId
        ? curveMap.get(curve.supersededByCurveId) ?? curve.supersededByCurveId
        : null,
      reviewBatchId: curve.reviewBatchId ? '(pending-batch)' : null,
      ratingIds: curve.ratingIds.map(remapRatingId),
      risingBranch: curve.risingBranch
        ? { ...curve.risingBranch, ratingIds: curve.risingBranch.ratingIds.map(remapRatingId) }
        : null,
      fallingBranch: curve.fallingBranch
        ? { ...curve.fallingBranch, ratingIds: curve.fallingBranch.ratingIds.map(remapRatingId) }
        : null
    }
  })
  const reviewBatches = payload.reviewBatches.map((batch) => {
    const id = createId('rvw')
    batchMap.set(batch.id, id)
    const remapCurveId = (curveId: string): string => curveMap.get(curveId) ?? curveId
    return {
      ...batch,
      id,
      stationId: stationMap.get(batch.stationId) ?? batch.stationId,
      baselineCurveId: batch.baselineCurveId ? remapCurveId(batch.baselineCurveId) : null,
      touchedCurveIds: batch.touchedCurveIds.map(remapCurveId),
      items: batch.items.map((item) => ({
        ...item,
        ratingId: ratingMap.get(item.ratingId) ?? item.ratingId
      })),
      rollback: Object.fromEntries(
        Object.entries(batch.rollback).map(([ratingId, snapshot]) => [
          ratingMap.get(ratingId) ?? ratingId,
          snapshot
        ])
      )
    }
  })
  // 回填点据 / 曲线上的复核批次 id
  payload.ratings.forEach((original) => {
    if (!original.reviewBatchId) return
    const newRatingId = ratingMap.get(original.id)
    const newBatchId = batchMap.get(original.reviewBatchId)
    const target = ratings.find((rating) => rating.id === newRatingId)
    if (newBatchId && target) target.reviewBatchId = newBatchId
  })
  payload.ratingCurves.forEach((original) => {
    if (!original.reviewBatchId) return
    const newCurveId = curveMap.get(original.id)
    const newBatchId = batchMap.get(original.reviewBatchId)
    const target = ratingCurves.find((curve) => curve.id === newCurveId)
    if (newBatchId && target) target.reviewBatchId = newBatchId
  })
  const compares = payload.compares.map((compare) => ({
    ...compare,
    id: createId('cmp'),
    ratingId: ratingMap.get(compare.ratingId) ?? compare.ratingId,
    curveId: compare.curveId ? curveMap.get(compare.curveId) ?? compare.curveId : null
  }))
  return {
    ...payload,
    stations,
    sections,
    verticals,
    points,
    ratings,
    ratingCurves,
    reviewBatches,
    compares
  }
}

/**
 * 生成结论文本：按测站输出最新水位、断面测次、当前绳套曲线参数与超限点据。
 * 供导出页的「检测结论」区域使用。
 */
export interface ConclusionLine {
  stationId: string
  stationName: string
  river: string
  sectionCount: number
  latestStageM: number | null
  ratingCount: number
  overLimitCount: number
  fitText: string
}

export function buildConclusionLines(payload: BackupPayload, curves: RatingCurve[]): ConclusionLine[] {
  return payload.stations.map((station) => {
    const sections = payload.sections.filter((section) => section.stationId === station.id)
    const latest = sections.reduce<number | null>((acc, section) => {
      if (acc === null) return section.stageM
      return section.stageM > acc ? section.stageM : acc
    }, null)
    const ratings = payload.ratings.filter((rating) => rating.stationId === station.id)
    const ratingIds = new Set(ratings.map((rating) => rating.id))
    const overLimitCount = payload.compares.filter(
      (compare) => ratingIds.has(compare.ratingId) && compare.verdict === '超限'
    ).length
    const lineNos = Array.from(new Set(ratings.map((rating) => rating.lineNo)))
    const activeByLine = new Map<string, RatingCurve>()
    curves
      .filter((curve) => curve.stationId === station.id && curve.status === '已确认')
      .forEach((curve) => activeByLine.set(curve.lineNo, curve))
    const fitParts = lineNos.map((lineNo) => {
      const curve = activeByLine.get(lineNo)
      if (!curve) return `${lineNo} 线未定线`
      const branchText = (['涨水', '退水'] as const)
        .map((direction) => {
          const branch = direction === '涨水' ? curve.risingBranch : curve.fallingBranch
          if (!branch?.fit.valid) return `${direction}支不足`
          return `${direction}支 Q=${branch.fit.a}(H-${branch.fit.h0})^${branch.fit.b}，残差 ${branch.fit.meanResidualPct}%`
        })
        .join('；')
      return `${lineNo} 线 v${curve.version}（${branchText}）`
    })
    return {
      stationId: station.id,
      stationName: station.name,
      river: station.river,
      sectionCount: sections.length,
      latestStageM: latest,
      ratingCount: ratings.length,
      overLimitCount,
      fitText: fitParts.length > 0 ? fitParts.join('；') : '暂无关系点据'
    }
  })
}
