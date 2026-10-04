/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入。
 * 与 utils/db.ts 的 BackupPayload 结构保持一致。
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

/** 备份集合键名 */
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

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [stations, sections, verticals, points, ratings, ratingCurves, reviewBatches, compares] = await Promise.all([
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

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbhydrogaug' && obj.app !== undefined) {
    errors.push('app 字段应为 gbhydrogaug，文件来源不明')
  }
  for (const key of BACKUP_KEYS) {
    if (!['ratingCurves', 'reviewBatches'].includes(key) && !Array.isArray(obj[key])) {
      errors.push(`${key} 字段缺失或不是数组`)
    }
  }
  for (const key of ['ratingCurves', 'reviewBatches'] as const) {
    if (obj[key] !== undefined && !Array.isArray(obj[key])) errors.push(`${key} 字段应为数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbhydrogaug',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    sections: (obj.sections ?? []).map((section) => ({
      ...section,
      trend: section.trend === '涨水' || section.trend === '退水' ? section.trend : '未知'
    })),
    ratings: (obj.ratings ?? []).map((rating) => ({
      ...rating,
      direction: rating.direction === '涨水' || rating.direction === '退水' ? rating.direction : '未知',
      status: rating.status === 'confirmed' || rating.status === 'stale' ? rating.status : 'pending',
      sourceRef: rating.sourceRef ?? null,
      sourceSnapshot: rating.sourceSnapshot ?? null,
      sourceSnapshotAt: rating.sourceSnapshotAt ?? null,
      staleReason: rating.staleReason ?? '',
      confirmedCurveId: rating.confirmedCurveId ?? null,
      confirmedAt: rating.confirmedAt ?? null
    })),
    ratingCurves: obj.ratingCurves ?? [],
    reviewBatches: obj.reviewBatches ?? [],
    compares: (obj.compares ?? []).map((compare) => ({
      ...compare,
      curveId: compare.curveId ?? null,
      branch: compare.branch === '涨水' || compare.branch === '退水' ? compare.branch : '未知',
      lineNo: compare.lineNo ?? ''
    })),
    stations: obj.stations ?? [],
    verticals: obj.verticals ?? [],
    points: obj.points ?? []
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

/** 导出 JSON 文件到浏览器下载目录 */
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
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.ratingCurves, db.reviewBatches, db.compares],
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

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const stationMap = new Map<string, string>()
  const sectionMap = new Map<string, string>()
  const verticalMap = new Map<string, string>()
  const ratingMap = new Map<string, string>()
  const pointMap = new Map<string, string>()
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
    return {
      ...point,
      id,
      verticalId: verticalMap.get(point.verticalId) ?? point.verticalId
    }
  })
  const ratings = payload.ratings.map((rating) => {
    const id = createId('rat')
    ratingMap.set(rating.id, id)
    return {
      ...rating,
      id,
      stationId: stationMap.get(rating.stationId) ?? rating.stationId,
      sourceRef: rating.sourceRef
        ? {
            sectionId: sectionMap.get(rating.sourceRef.sectionId) ?? rating.sourceRef.sectionId,
            verticalId: rating.sourceRef.verticalId
              ? verticalMap.get(rating.sourceRef.verticalId) ?? rating.sourceRef.verticalId
              : undefined,
            pointId: rating.sourceRef.pointId
              ? pointMap.get(rating.sourceRef.pointId) ?? rating.sourceRef.pointId
              : undefined
          }
        : rating.sourceRef,
      sourceSnapshot: rating.sourceSnapshot
        ? {
            ...rating.sourceSnapshot,
            section: rating.sourceSnapshot.section
              ? {
                  ...rating.sourceSnapshot.section,
                  id: sectionMap.get(rating.sourceSnapshot.section.id) ?? rating.sourceSnapshot.section.id
                }
              : null,
            verticals: rating.sourceSnapshot.verticals.map((vertical) => ({
              ...vertical,
              id: verticalMap.get(vertical.id) ?? vertical.id
            })),
            points: rating.sourceSnapshot.points.map((point) => ({
              ...point,
              id: pointMap.get(point.id) ?? createId('pnt')
            })),
            flow: rating.sourceSnapshot.flow
              ? {
                  ...rating.sourceSnapshot.flow,
                  slices: rating.sourceSnapshot.flow.slices.map((slice) => ({
                    ...slice,
                    id: verticalMap.get(slice.id) ?? slice.id
                  }))
                }
              : null
          }
        : rating.sourceSnapshot
    }
  })
  const ratingCurves = payload.ratingCurves.map((curve) => {
    const id = createId('crv')
    curveMap.set(curve.id, id)
    return {
      ...curve,
      id,
      stationId: stationMap.get(curve.stationId) ?? curve.stationId,
      fit: { ...curve.fit, lineNo: curve.lineNo, branch: curve.branch },
      ratingIds: curve.ratingIds.map((ratingId) => ratingMap.get(ratingId) ?? ratingId),
      previousCurveId: curve.previousCurveId ? curveMap.get(curve.previousCurveId) ?? curve.previousCurveId : null,
      supersededByCurveId: curve.supersededByCurveId
        ? curveMap.get(curve.supersededByCurveId) ?? curve.supersededByCurveId
        : null
    }
  })
  ratingCurves.forEach((curve) => {
    if (!curve.previousCurveId) return
    const previous = ratingCurves.find((item) => item.id === curve.previousCurveId)
    if (previous) previous.supersededByCurveId = curve.id
  })
  const reviewBatches = payload.reviewBatches.map((batch) => {
    const id = createId('rb')
    batchMap.set(batch.id, id)
    return {
      ...batch,
      id,
      stationId: stationMap.get(batch.stationId) ?? batch.stationId,
      confirmedCurveIds: batch.confirmedCurveIds.map((curveId) => curveMap.get(curveId) ?? curveId),
      beforeRatings: batch.beforeRatings
        .map((rating) => ratings.find((item) => item.id === ratingMap.get(rating.id)))
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
      beforeCurves: batch.beforeCurves
        .map((curve) => ratingCurves.find((item) => item.id === curveMap.get(curve.id)))
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
      beforeCompares: batch.beforeCompares
        .map((compare) => ({
          ...compare,
          id: createId('cmp'),
          ratingId: ratingMap.get(compare.ratingId) ?? compare.ratingId,
          curveId: compare.curveId ? curveMap.get(compare.curveId) ?? compare.curveId : null
        })),
      afterRatings: batch.afterRatings
        ? batch.afterRatings
            .map((rating) => ratings.find((item) => item.id === ratingMap.get(rating.id)))
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
        : undefined,
      afterCurves: batch.afterCurves
        ? batch.afterCurves
            .map((curve) => ratingCurves.find((item) => item.id === curveMap.get(curve.id)))
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
        : undefined,
      afterCompares: batch.afterCompares
        ? batch.afterCompares.map((compare) => ({
            ...compare,
            id: createId('cmp'),
            ratingId: ratingMap.get(compare.ratingId) ?? compare.ratingId,
            curveId: compare.curveId ? curveMap.get(compare.curveId) ?? compare.curveId : null
          }))
        : undefined
    }
  })
  ratingCurves.forEach((curve) => {
    curve.reviewBatchId = batchMap.get(curve.reviewBatchId) ?? curve.reviewBatchId
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
 * 生成结论文本：按测站输出最新水位、断面测次、定线参数与超限点据。
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

export function buildConclusionLines(
  payload: BackupPayload,
  fits: Array<{ lineNo: string; branch?: string; valid: boolean; a: number; b: number; h0: number; meanResidualPct: number; sampleCount: number }>
): ConclusionLine[] {
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
    const lineKeys = Array.from(new Set(ratings.map((rating) => rating.lineNo)))
    const fitParts = lineKeys.flatMap((lineNo) =>
      fits
        .filter((fit) => fit.lineNo === lineNo)
        .map((fit) => {
          if (!fit.valid) return `${lineNo}线${fit.branch ?? ''}未定线`
          return `${lineNo}线${fit.branch ?? ''} Q=${fit.a}·(H-${fit.h0})^${fit.b}，残差 ${fit.meanResidualPct}%（${fit.sampleCount} 点）`
        })
    )
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
