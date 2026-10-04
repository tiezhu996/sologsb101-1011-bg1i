/**
 * 历史升级（v2 → v3）与导入导出状态携带的运行时验证。
 * 运行：npx vite-node scripts/verify-upgrade-export.ts
 */
import 'fake-indexeddb/auto'
import { db, DB_NAME } from '../src/utils/db'
import { buildBackupPayload, validateBackup, remapIds, importBackup } from '../src/utils/export'
import { inferDirections } from '../src/utils/provenance'
import { detectBranchCross } from '../src/types/review'
import { fitPowerCurve } from '../src/types/rating'

let passed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`✗ ${name} ${detail}`)
    process.exitCode = 1
    throw new Error(name)
  }
  passed += 1
  console.log(`✓ ${name} ${detail}`)
}

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

async function seedV2ThenUpgrade(): Promise<void> {
  await deleteDb()

  // 直接用原生 IndexedDB 建 v2 库（绕开当前 v3 声明），再用新版应用打开触发 upgrade
  await new Promise<void>((resolve, reject) => {
    const openReq = indexedDB.open(DB_NAME, 2)
    openReq.onupgradeneeded = () => {
      const d = openReq.result
      d.createObjectStore('stations', { keyPath: 'id' })
      d.createObjectStore('sections', { keyPath: 'id' })
      d.createObjectStore('verticals', { keyPath: 'id' })
      d.createObjectStore('points', { keyPath: 'id' })
      d.createObjectStore('ratings', { keyPath: 'id' })
      d.createObjectStore('compares', { keyPath: 'id' })
    }
    openReq.onsuccess = () => {
      const d = openReq.result
      const now = Date.now()
      const tx = d.transaction(['stations', 'sections', 'verticals', 'points', 'ratings', 'compares'], 'readwrite')
      tx.objectStore('stations').put({
        id: 'stn_old', name: '老城站', river: '渭河', catchmentKm2: 900, sectionCode: 'CS-OLD',
        remark: '', createdAt: now, updatedAt: now
      })
      // 三个测次，水位先升后降，用于验证方向推断
      tx.objectStore('sections').put({ id: 'sec_1', stationId: 'stn_old', measureNo: 'M-1', startDistanceM: 1, stageM: 3.0, method: '流速仪', measuredAt: '2024-05-01T00:00:00.000Z', createdAt: now, updatedAt: now })
      tx.objectStore('sections').put({ id: 'sec_2', stationId: 'stn_old', measureNo: 'M-2', startDistanceM: 1, stageM: 4.0, method: '流速仪', measuredAt: '2024-06-01T00:00:00.000Z', createdAt: now, updatedAt: now })
      tx.objectStore('sections').put({ id: 'sec_3', stationId: 'stn_old', measureNo: 'M-3', startDistanceM: 1, stageM: 3.5, method: '流速仪', measuredAt: '2024-07-01T00:00:00.000Z', createdAt: now, updatedAt: now })
      // 旧点据：b1 匹配测次 M-1，bX 无匹配测次（缺来源）
      tx.objectStore('ratings').put({ id: 'rat_old1', stationId: 'stn_old', stageM: 3.0, flowM3s: 40, lineNo: 'A', measureNo: 'M-1', measuredAt: '2024-05-01T00:00:00.000Z', createdAt: now, updatedAt: now })
      tx.objectStore('ratings').put({ id: 'rat_old2', stationId: 'stn_old', stageM: 4.0, flowM3s: 80, lineNo: 'A', measureNo: 'M-2', measuredAt: '2024-06-01T00:00:00.000Z', createdAt: now, updatedAt: now })
      tx.objectStore('ratings').put({ id: 'rat_old3', stationId: 'stn_old', stageM: 3.5, flowM3s: 60, lineNo: 'A', measureNo: 'M-3', measuredAt: '2024-07-01T00:00:00.000Z', createdAt: now, updatedAt: now })
      tx.objectStore('ratings').put({ id: 'rat_orphan', stationId: 'stn_old', stageM: 5.0, flowM3s: 120, lineNo: 'A', measureNo: 'M-X', measuredAt: '2024-08-01T00:00:00.000Z', createdAt: now, updatedAt: now })
      tx.oncomplete = () => { d.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    openReq.onerror = () => reject(openReq.error)
  })

  // 2) 用新版（v3）打开，触发升级迁移
  await db.open()
}

async function main(): Promise<void> {
  /* ---------- 方向推断纯函数 ---------- */
  const dirs = inferDirections([
    { measureKey: 'r1', measuredAt: '2024-05-01T00:00:00.000Z', stageM: 3.0 },
    { measureKey: 'r2', measuredAt: '2024-06-01T00:00:00.000Z', stageM: 4.0 },
    { measureKey: 'r3', measuredAt: '2024-07-01T00:00:00.000Z', stageM: 3.5 }
  ])
  check('首测次方向不明', dirs.get('r1') === '不明')
  check('水位升高判涨水', dirs.get('r2') === '涨水')
  check('水位下降判退水', dirs.get('r3') === '退水')

  /* ---------- v2 → v3 升级 ---------- */
  await seedV2ThenUpgrade()
  const ratings = await db.ratings.toArray()
  const r1 = ratings.find((r) => r.id === 'rat_old1')!
  const r3 = ratings.find((r) => r.id === 'rat_old3')!
  const orphan = ratings.find((r) => r.id === 'rat_orphan')!
  check('升级补齐来源断面', r1.sourceSectionId === 'sec_1')
  check('升级按序列补方向（涨水）', r1.direction === '涨水', r1.direction)
  check('升级按序列补方向（退水）', r3.direction === '退水', r3.direction)
  check('有来源且方向明确 → 已确认', r1.status === '已确认' && r3.status === '已确认')
  check('缺来源点据留在待确认', orphan.status === '待确认' && orphan.sourceSectionId === null, `方向=${orphan.direction}`)

  // 只有 3 个已确认点据且均为涨水（首点不明未确认）→ 不足以单独成涨水支（<3 已确认中首点为不明）
  const curves = await db.ratingCurves.toArray()
  check('升级不产生悬空曲线（已确认点据不足 3 时）', curves.every((c) => c.status === '已确认'))
  await db.close()

  /* ---------- 导出携带全部状态 ---------- */
  await db.open()
  const payload = await buildBackupPayload()
  check('导出包含八张表', Array.isArray(payload.ratingCurves) && Array.isArray(payload.reviewBatches))
  check('导出点据带来源 / 方向 / 状态', payload.ratings.every((r) => 'sourceSectionId' in r && 'direction' in r && 'status' in r))
  const json = JSON.stringify(payload)
  const reparsed = JSON.parse(json)
  const validated = validateBackup(reparsed)
  check('导出文件回读校验通过', validated.ok, validated.errors.join(';'))
  check('回读后状态保留', validated.payload!.ratings.find((r) => r.id === 'rat_orphan')?.status === '待确认')

  /* ---------- 导入旧版（v2 结构）备份归一化 ---------- */
  const legacyPayload = {
    app: 'gbhydrogaug',
    dbVersion: 2,
    exportedAt: new Date().toISOString(),
    stations: [{ id: 's1', name: 'X', river: 'R', catchmentKm2: 1, sectionCode: 'C', remark: '', createdAt: 1, updatedAt: 1 }],
    sections: [],
    verticals: [],
    points: [],
    ratings: [
      { id: 'x1', stationId: 's1', stageM: 1, flowM3s: 10, lineNo: 'A', measureNo: '', measuredAt: new Date().toISOString() }
    ],
    compares: [
      { id: 'c1', ratingId: 'x1', measuredFlow: 10, curveFlow: 11, deviationPct: 10, verdict: '超限', operator: '', comparedAt: new Date().toISOString(), createdAt: 1, updatedAt: 1 }
    ]
  }
  const legacy = validateBackup(legacyPayload)
  check('旧版备份可校验', legacy.ok)
  check('旧版缺来源点据归一为待确认 / 不明', legacy.payload!.ratings[0].status === '待确认' && legacy.payload!.ratings[0].direction === '不明')
  check('旧版比测补 curveId 与分支', legacy.payload!.compares[0].curveId === null && legacy.payload!.compares[0].branch === '不明')

  /* ---------- 追加导入重映射 id 后引用仍一致 ---------- */
  const remapped = remapIds(validated.payload!)
  const remappedOrphan = remapped.ratings.find((r) => r.id !== 'rat_orphan') ? remapped.ratings.find((r) => r.measureNo === 'M-X') : undefined
  check('追加导入点据 id 已重分配', remapped.ratings.every((r) => !r.id.startsWith('rat_old')))
  check('追加导入测站外键已重映射', remapped.sections.every((s) => remapped.stations.some((st) => st.id === s.stationId)))
  check('追加导入状态保留', remappedOrphan?.status === '待确认')

  // 覆盖导入落库验证
  await importBackup(legacy.payload!, true)
  const imported = await db.ratings.toArray()
  check('覆盖导入后旧数据被替换', imported.length === 1 && imported[0].id === 'x1' && imported[0].status === '待确认')
  await db.close()

  /* ---------- 交叉检测对 b≤0 分支仍工作 ---------- */
  const rising = fitPowerCurve([{ stageM: 3, flowM3s: 50 }, { stageM: 3.5, flowM3s: 80 }, { stageM: 4, flowM3s: 120 }], 'X', '涨水')
  const falling = fitPowerCurve([{ stageM: 3, flowM3s: 120 }, { stageM: 3.5, flowM3s: 80 }, { stageM: 4, flowM3s: 50 }], 'X', '退水')
  const conflicts = detectBranchCross(rising, falling, {
    rising: [{ stageM: 3 }, { stageM: 3.5 }, { stageM: 4 }],
    falling: [{ stageM: 3 }, { stageM: 3.5 }, { stageM: 4 }]
  })
  check('交叉检测对反向退水支生效', conflicts.length === 1 && Math.abs(conflicts[0].stageM - 3.5) < 0.1, `cross@${conflicts[0]?.stageM}`)

  console.log(`\n全部 ${passed} 项检查通过`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
