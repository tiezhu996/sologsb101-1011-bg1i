/**
 * 可追溯绳套定线核心工作流的运行时验证（Node + fake-indexeddb）。
 * 运行：npx tsx scripts/verify-rating-workflow.ts
 */
import 'fake-indexeddb/auto'
import { assert } from 'node:console'
import { db, resetDatabase } from '../src/utils/db'
import { useReviewStore } from '../src/stores/reviewStore'
import { useSectionStore } from '../src/stores/sectionStore'
import type { Rating } from '../src/types/rating'

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

async function main(): Promise<void> {
  await resetDatabase()

  // Pinia store 需要 active pinia 实例
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const review = useReviewStore()
  const section = useSectionStore()
  review.start()
  section.start()
  // 等待 liveQuery 初次推送
  await new Promise((resolve) => setTimeout(resolve, 300))

  /* ---------- 1. 播种后每站线有已确认曲线，B 线含涨 / 退两支 ---------- */
  const qjCurve = review.activeCurve('stn_qj02', 'B')
  check('青矶 B 线存在已确认曲线', qjCurve !== null, `v${qjCurve?.version ?? 0}`)
  check('B 线涨水支有效', Boolean(qjCurve?.risingBranch?.fit.valid), `${qjCurve?.risingBranch?.fit.sampleCount} 点`)
  check('B 线退水支有效', Boolean(qjCurve?.fallingBranch?.fit.valid), `${qjCurve?.fallingBranch?.fit.sampleCount} 点`)
  check('B 线涨退各不少于 3 点', (qjCurve?.risingBranch?.fit.sampleCount ?? 0) >= 3 && (qjCurve?.fallingBranch?.fit.sampleCount ?? 0) >= 3)

  // 同一水位（3.18）涨水流量应大于退水流量（绳套）
  const risingFlow = qjCurve!.risingBranch!.fit
  const fallingFlow = qjCurve!.fallingBranch!.fit
  const qRising = risingFlow.a * Math.pow(Math.max(3.18 - risingFlow.h0, 1e-6), risingFlow.b)
  const qFalling = fallingFlow.a * Math.pow(Math.max(3.18 - fallingFlow.h0, 1e-6), fallingFlow.b)
  check('同水位 3.18m 涨水支流量大于退水支（绳套可见）', qRising > qFalling, `涨 ${qRising.toFixed(1)} vs 退 ${qFalling.toFixed(1)}`)

  // 点据带溯源与快照
  const b2 = review.ratings.find((r) => r.id === 'rat_qj_b2')!
  check('点据记住来源断面', b2.sourceSectionId === 'sec_qj_2405')
  check('点据记住来源垂线', b2.sourceVerticalIds.length > 0, `${b2.sourceVerticalIds.length} 条`)
  check('点据记住来源测点', b2.sourcePoints.length > 0, `${b2.sourcePoints.length} 点`)
  check('点据带流量快照', b2.snapshot !== null && b2.snapshot.flowM3s > 0, `Q=${b2.snapshot?.flowM3s}`)

  // C 线仍含超限比测
  const overLimit = review.compares.filter((c) => c.verdict === '超限')
  check('C 线保留超限比测点', overLimit.length >= 1, `${overLimit.length} 条超限`)

  /* ---------- 2. 测次重测：旧值保留、旧曲线失效、点据转待复核 ---------- */
  const oldFlow = b2.flowM3s
  // 修改退水/涨水来源测次 sec_qj_2405 的测点流速（模拟重测）
  const v1Points = section.points.filter((p) => p.verticalId === 'vrt_qj_1' || p.verticalId === 'vrt_qj_2')
  await section.updatePoint(v1Points[0].id, { velocityMs: v1Points[0].velocityMs + 0.4 })
  await new Promise((resolve) => setTimeout(resolve, 150))

  const b2After = review.ratings.find((r) => r.id === 'rat_qj_b2') as Rating
  check('重测后点据仍按旧值参与（未覆盖）', Math.abs(b2After.flowM3s - oldFlow) < 1e-6, `旧值 ${oldFlow} 保留`)
  check('点据快照标记脱节', b2After.snapshotStale === true)
  check('点据转待复核', b2After.status === '待复核')
  const qjCurveAfter = review.curves.find((c) => c.id === qjCurve!.id)!
  check('旧定线先失效', qjCurveAfter.status === '已失效', qjCurveAfter.invalidateReason)

  /* ---------- 3. 发起复核：两支试算，刷新快照采纳新值 ---------- */
  let batch = await review.startReview('stn_qj02', 'B')
  check('复核批次纳入待复核点据', batch.items.length >= 1, `${batch.items.length} 点`)
  const item = batch.items.find((i) => i.ratingId === 'rat_qj_b2')!
  check('复核保留旧值列', Math.abs(item.previousFlowM3s - oldFlow) < 1e-6)
  check('初始无交叉冲突（正常绳套）', batch.conflicts.length === 0, batch.message)

  await review.refreshSnapshot(batch.id, 'rat_qj_b2')
  await new Promise((resolve) => setTimeout(resolve, 60))
  batch = (await db.reviewBatches.get(batch.id))!
  const refreshed = batch.items.find((i) => i.ratingId === 'rat_qj_b2')!
  check('刷新后采用值变为新测次成果', Math.abs(refreshed.flowM3s - oldFlow) > 1e-6, `新值 ${refreshed.flowM3s.toFixed(1)}`)

  /* ---------- 4. 复核失败回滚：恢复上次确认 ---------- */
  await review.rollbackReview(batch.id)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const b2Rolled = review.ratings.find((r) => r.id === 'rat_qj_b2') as Rating
  check('回滚后点据恢复旧值', Math.abs(b2Rolled.flowM3s - oldFlow) < 1e-6)
  check('回滚后点据恢复待复核', b2Rolled.status === '待复核')
  const qjCurveRestored = review.curves.find((c) => c.id === qjCurve!.id)!
  check('回滚后旧曲线恢复已确认', qjCurveRestored.status === '已确认')
  check('回滚后比测结果保留', review.compares.some((c) => c.curveId === qjCurve!.id))

  /* ---------- 5. 再次复核并确认：发布 v2，旧版本留痕 ---------- */
  batch = await review.startReview('stn_qj02', 'B')
  await review.refreshSnapshot(batch.id, 'rat_qj_b2')
  const confirmResult = await review.confirmReview(batch.id)
  await new Promise((resolve) => setTimeout(resolve, 100))
  check('复核确认成功', confirmResult.ok, confirmResult.reason)
  check('发布 v2 新曲线', confirmResult.curve?.version === 2, `v${confirmResult.curve?.version}`)
  const oldV1 = review.curves.find((c) => c.id === qjCurve!.id)!
  check('旧 v1 留痕失效且指向 v2', oldV1.status === '已失效' && oldV1.supersededByCurveId === confirmResult.curve!.id)
  const b2Confirmed = review.ratings.find((r) => r.id === 'rat_qj_b2') as Rating
  check('确认后点据已确认、快照不脱节', b2Confirmed.status === '已确认' && !b2Confirmed.snapshotStale)
  const v2Compare = review.compares.find((c) => c.ratingId === 'rat_qj_b2')
  check('比测挂到新曲线 v2', v2Compare?.curveId === confirmResult.curve!.id)

  /* ---------- 6. 交叉冲突检出（构造交叉点据） ---------- */
  // 在青矶新线 D 上构造涨退水水位重叠且大小关系翻转的两组点
  const now = Date.now()
  const mk = (id: string, stageM: number, flowM3s: number, direction: '涨水' | '退水'): Rating => ({
    id,
    stationId: 'stn_qj02',
    stageM,
    flowM3s,
    lineNo: 'D',
    measureNo: id,
    measuredAt: new Date(now).toISOString(),
    sourceSectionId: null,
    sourceVerticalIds: [],
    sourcePoints: [],
    snapshot: null,
    snapshotStale: false,
    direction,
    status: '待复核',
    reviewBatchId: null,
    note: '交叉冲突构造',
    createdAt: now,
    updatedAt: now
  })
  await db.ratings.bulkPut([
    mk('rat_d_r1', 3.0, 50, '涨水'),
    mk('rat_d_r2', 3.5, 80, '涨水'),
    mk('rat_d_r3', 4.0, 120, '涨水'),
    mk('rat_d_f1', 3.0, 120, '退水'),
    mk('rat_d_f2', 3.5, 80, '退水'),
    mk('rat_d_f3', 4.0, 50, '退水')
  ])
  await new Promise((resolve) => setTimeout(resolve, 80))
  const crossBatch = await review.startReview('stn_qj02', 'D')
  check('交叉批次检出冲突', crossBatch.conflicts.length === 1, crossBatch.conflicts[0]?.message ?? '')
  const blocked = await review.confirmReview(crossBatch.id)
  check('存在交叉冲突时禁止确认', blocked.ok === false, blocked.reason)

  /* ---------- 7. 缺来源 / 方向不明留在待确认，不参与定线 ---------- */
  const pending = review.ratings.filter((r) => r.lineNo === 'D')
  // 把方向改不明的点不应出现在任何曲线
  check('待复核点据未产生已确认 D 曲线', review.activeCurve('stn_qj02', 'D') === null)
  void assert
  void pending

  console.log(`\n全部 ${passed} 项检查通过`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
