/**
 * 复核 store：可追溯绳套定线的核心工作流。
 *
 * 职责：
 * - 订阅点据、绳套曲线、复核批次、比测记录；
 * - 原始测次补录 / 重测后：旧曲线先失效、点据转待复核（保留旧值，不覆盖）；
 * - 发起复核：按涨水 / 退水两支试算，水位重叠且两支交叉先列冲突；
 * - 复核确认：提交新版本曲线（旧版本留痕）并重算比测；
 * - 一批复核失败：回滚到上次确认的测次，已确认曲线与比测保留。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createId, db, watchTable } from '@/utils/db'
import type { Rating, TrendDirection, RatingPointStatus } from '@/types/rating'
import { isPointUsableForCurve } from '@/types/rating'
import type { RatingCurve } from '@/types/curve'
import type { ReviewBatch, ReviewPointItem } from '@/types/review'
import { branchSamples, detectBranchCross } from '@/types/review'
import type { Compare } from '@/types/compare'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import { buildProvenanceSnapshot } from '@/utils/provenance'
import { buildRatingCurve, curveHasValidBranch, markStaleForSection, rebuildComparesForCurves } from '@/utils/curveOps'
import { fitPowerCurve } from '@/types/rating'

export const useReviewStore = defineStore('review', () => {
  const ratings = ref<Rating[]>([])
  const curves = ref<RatingCurve[]>([])
  const batches = ref<ReviewBatch[]>([])
  const compares = ref<Compare[]>([])
  const sections = ref<Section[]>([])
  const verticals = ref<Vertical[]>([])
  const points = ref<Point[]>([])
  const ready = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
    })
    watchTable<RatingCurve>(() => db.ratingCurves).subscribe((rows) => {
      curves.value = rows
    })
    watchTable<ReviewBatch>(() => db.reviewBatches).subscribe((rows) => {
      batches.value = rows
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
    })
    watchTable<Vertical>(() => db.verticals).subscribe((rows) => {
      verticals.value = rows
    })
    watchTable<Point>(() => db.points).subscribe((rows) => {
      points.value = rows
    })
  }

  /* ------------------------------ 派生查询 ------------------------------ */

  /** 某测站 × 线号当前已确认曲线（无则 null） */
  function activeCurve(stationId: string, lineNo: string): RatingCurve | null {
    return (
      curves.value.find(
        (curve) => curve.stationId === stationId && curve.lineNo === lineNo && curve.status === '已确认'
      ) ?? null
    )
  }

  /** 某测站 × 线号的历史版本（含已失效留痕），按版本倒序 */
  function curveHistory(stationId: string, lineNo: string): RatingCurve[] {
    return curves.value
      .filter((curve) => curve.stationId === stationId && curve.lineNo === lineNo)
      .sort((a, b) => b.version - a.version)
  }

  /**
   * 本批复核要回滚到的「上次确认曲线」。
   * 正常流程是测次先更新、旧曲线先失效，之后才发起复核，因此当前已确认曲线往往已为 null；
   * 此时回滚目标是该站线「最近失效、且尚未被任何新版本替代」的曲线（即本次待重算所取代的那一版）。
   */
  function baselineCurveFor(stationId: string, lineNo: string): RatingCurve | null {
    const active = activeCurve(stationId, lineNo)
    if (active) return active
    const pendingSuperseded = curves.value
      .filter(
        (curve) =>
          curve.stationId === stationId &&
          curve.lineNo === lineNo &&
          curve.status === '已失效' &&
          !curve.supersededByCurveId
      )
      .sort((a, b) => b.version - a.version)
    return pendingSuperseded[0] ?? null
  }

  /** 该站线是否存在进行中的复核批次 */
  function openBatch(stationId: string, lineNo: string): ReviewBatch | null {
    return (
      batches.value.find(
        (batch) => batch.stationId === stationId && batch.lineNo === lineNo && batch.status === '进行中'
      ) ?? null
    )
  }

  /** 全部进行中的复核批次 */
  const openBatches = computed<ReviewBatch[]>(() =>
    batches.value.filter((batch) => batch.status === '进行中')
  )

  /** 点据 id → 当前占用它的复核批次 */
  const batchByRatingId = computed<Map<string, ReviewBatch>>(() => {
    const map = new Map<string, ReviewBatch>()
    batches.value
      .filter((batch) => batch.status === '进行中')
      .forEach((batch) => batch.items.forEach((item) => map.set(item.ratingId, batch)))
    return map
  })

  function batchOfRating(ratingId: string): ReviewBatch | null {
    return batchByRatingId.value.get(ratingId) ?? null
  }

  /** 各站线复核状态汇总（页面徽标消费） */
  const stationLineStatus = computed<
    Record<string, { hasStale: boolean; pendingCount: number; openBatch: boolean; activeVersion: number | null }>
  >(() => {
    const map: Record<
      string,
      { hasStale: boolean; pendingCount: number; openBatch: boolean; activeVersion: number | null }
    > = {}
    const keyOf = (stationId: string, lineNo: string): string => `${stationId}::${lineNo}`
    const touch = (stationId: string, lineNo: string) => {
      const key = keyOf(stationId, lineNo)
      if (!map[key]) map[key] = { hasStale: false, pendingCount: 0, openBatch: false, activeVersion: null }
      return map[key]
    }
    ratings.value.forEach((rating) => {
      const bucket = touch(rating.stationId, rating.lineNo)
      if (rating.snapshotStale || rating.status === '待复核') bucket.hasStale = true
      if (rating.status !== '已确认') bucket.pendingCount += 1
    })
    batches.value.forEach((batch) => {
      touch(batch.stationId, batch.lineNo).openBatch = batch.status === '进行中'
    })
    curves.value.forEach((curve) => {
      if (curve.status === '已确认') touch(curve.stationId, curve.lineNo).activeVersion = curve.version
    })
    return map
  })

  /* ----------------------- 测次补录 / 重测 → 失效 ----------------------- */

  /**
   * 来源测次成果变化（测次补录 / 重测，或其垂线、测点改动）后调用：
   * 来源于该断面的点据保留旧值但标记快照脱节、转待复核，其已确认曲线置失效，
   * 等待复核后重算，绝不就地覆盖。
   */
  async function invalidateSection(sectionId: string, reason = '来源测次补录 / 重测'): Promise<number> {
    const currentRatings = await db.ratings.toArray()
    const currentCurves = await db.ratingCurves.toArray()
    const { staleRatingIds, affectedCurveIds } = markStaleForSection(
      currentRatings,
      currentCurves,
      sectionId
    )
    if (staleRatingIds.length === 0) return 0
    const now = Date.now()

    await db.transaction(
      'rw',
      [db.ratings, db.ratingCurves, db.reviewBatches],
      async () => {
        await db.ratings
          .where('id')
          .anyOf(staleRatingIds)
          .modify((rating: Rating) => {
            rating.snapshotStale = true
            rating.status = '待复核'
            rating.reviewBatchId = null
            rating.updatedAt = now
          })
        if (affectedCurveIds.length > 0) {
          await db.ratingCurves
            .where('id')
            .anyOf(affectedCurveIds)
            .modify((curve: RatingCurve) => {
              curve.status = '已失效'
              curve.invalidatedAt = new Date(now).toISOString()
              curve.invalidateReason = reason
              curve.updatedAt = now
            })
        }
        // 进行中但包含这些点据的批次：标记其试算依据已过期
        const open = await db.reviewBatches.filter((batch) => batch.status === '进行中').toArray()
        const staleSet = new Set(staleRatingIds)
        for (const batch of open) {
          if (!batch.items.some((item) => staleSet.has(item.ratingId))) continue
          await db.reviewBatches.update(batch.id, {
            message: `来源测次已再次更新，请刷新快照或重新试算（${reason}）`,
            updatedAt: now
          } as never)
        }
      }
    )
    return staleRatingIds.length
  }

  /* ------------------------------ 发起复核 ------------------------------ */

  /** 由批次当前 items 试算两支拟合与交叉冲突 */
  function evaluateBatch(batch: Pick<ReviewBatch, 'stationId' | 'lineNo' | 'items'>): {
    risingFit: ReviewBatch['risingFit']
    fallingFit: ReviewBatch['fallingFit']
    conflicts: ReviewBatch['conflicts']
    message: string
  } {
    const risingSamples = branchSamples(batch.items, '涨水')
    const fallingSamples = branchSamples(batch.items, '退水')
    const risingFit = fitPowerCurve(risingSamples, batch.lineNo, '涨水')
    const fallingFit = fitPowerCurve(fallingSamples, batch.lineNo, '退水')
    const conflicts = detectBranchCross(risingFit, fallingFit, {
      rising: risingSamples,
      falling: fallingSamples
    })
    const parts: string[] = []
    parts.push(risingFit.valid ? `涨水支 ${risingFit.sampleCount} 点有效` : `涨水支：${risingFit.message}`)
    parts.push(fallingFit.valid ? `退水支 ${fallingFit.sampleCount} 点有效` : `退水支：${fallingFit.message}`)
    if (conflicts.length > 0) parts.push(`检出 ${conflicts.length} 处两支交叉，须先处理`)
    return {
      risingFit,
      fallingFit,
      conflicts,
      message: parts.join('；')
    }
  }

  /**
   * 发起一批复核：默认纳入该站线所有「待复核」点据（也可指定 ratingIds）。
   * 若已有进行中批次则直接返回它，保证同一站线同时只有一个复核事务。
   */
  async function startReview(
    stationId: string,
    lineNo: string,
    options: { ratingIds?: string[]; operator?: string } = {}
  ): Promise<ReviewBatch> {
    const existing = openBatch(stationId, lineNo)
    if (existing) return existing

    const now = Date.now()
    const baseline = baselineCurveFor(stationId, lineNo)
    const scope = ratings.value.filter((rating) => rating.stationId === stationId && rating.lineNo === lineNo)
    const wantedIds = options.ratingIds ? new Set(options.ratingIds) : null
    // 复核一批 = 当前曲线涉及的全部点据：脱节点据转待复核刷新，其余点据保留原采用值；
    // 缺来源 / 方向不明的待确认点据也一并带入，供人工改分支后纳入。
    const baselineIds = new Set(baseline?.ratingIds ?? [])
    const targets = scope.filter((rating) => {
      if (wantedIds && !wantedIds.has(rating.id)) return false
      if (rating.status === '待复核') return true
      if (rating.status === '待确认') return true
      // 已确认点据：属于上次曲线（重算范围）时纳入
      return baselineIds.has(rating.id)
    })
    const items: ReviewPointItem[] = targets.map((rating) => ({
      ratingId: rating.id,
      direction: rating.direction,
      included: rating.direction !== '不明',
      previousStageM: rating.stageM,
      previousFlowM3s: rating.flowM3s,
      stageM: rating.stageM,
      flowM3s: rating.flowM3s,
      snapshotStale: rating.snapshotStale
    }))

    const batchId = createId('rvw')
    const draft: Pick<ReviewBatch, 'stationId' | 'lineNo' | 'items'> = { stationId, lineNo, items }
    const evaluation = evaluateBatch(draft)

    const batch: ReviewBatch = {
      id: batchId,
      stationId,
      lineNo,
      status: '进行中',
      items,
      baselineCurveId: baseline?.id ?? null,
      rollback: Object.fromEntries(
        targets.map((rating) => [
          rating.id,
          {
            status: rating.status,
            direction: rating.direction,
            stageM: rating.stageM,
            flowM3s: rating.flowM3s,
            snapshotStale: rating.snapshotStale,
            reviewBatchId: rating.reviewBatchId
          }
        ])
      ),
      touchedCurveIds: baseline ? [baseline.id] : [],
      risingFit: evaluation.risingFit,
      fallingFit: evaluation.fallingFit,
      conflicts: evaluation.conflicts,
      message: evaluation.message,
      operator: options.operator ?? '林昭',
      createdAt: now,
      updatedAt: now,
      finishedAt: null
    }

    await db.transaction(
      'rw',
      [db.ratings, db.reviewBatches],
      async () => {
        await db.reviewBatches.put(batch)
        if (targets.length > 0) {
          await db.ratings
            .where('id')
            .anyOf(targets.map((rating) => rating.id))
            .modify((rating: Rating) => {
              rating.reviewBatchId = batchId
              rating.updatedAt = now
            })
        }
      }
    )
    return batch
  }

  /** 用来源测次当前成果刷新某点据的流量快照（复核中采纳新值） */
  async function refreshSnapshot(batchId: string, ratingId: string): Promise<void> {
    const batch = await db.reviewBatches.get(batchId)
    if (!batch || batch.status !== '进行中') return
    const rating = await db.ratings.get(ratingId)
    if (!rating || !rating.sourceSectionId) return
    const section = await db.sections.get(rating.sourceSectionId)
    if (!section) return
    const sectionVerticals = await db.verticals.where('sectionId').equals(section.id).toArray()
    const sectionPoints =
      sectionVerticals.length > 0
        ? await db.points
            .where('verticalId')
            .anyOf(sectionVerticals.map((vertical) => vertical.id))
            .toArray()
        : []
    const now = Date.now()
    const provenance = buildProvenanceSnapshot(
      { section, verticals: sectionVerticals, points: sectionPoints },
      new Date(now).toISOString()
    )
    const items = batch.items.map((item) =>
      item.ratingId === ratingId
        ? {
            ...item,
            stageM: provenance.snapshot.stageM,
            flowM3s: provenance.snapshot.flowM3s,
            snapshotStale: false
          }
        : item
    )
    const evaluation = evaluateBatch({ stationId: batch.stationId, lineNo: batch.lineNo, items })
    await db.reviewBatches.update(batchId, {
      items,
      risingFit: evaluation.risingFit,
      fallingFit: evaluation.fallingFit,
      conflicts: evaluation.conflicts,
      message: evaluation.message,
      updatedAt: now
    } as never)
  }

  /** 复核中调整单个点据：改分支 / 是否纳入 / 直接改采用值 */
  async function updateReviewItem(
    batchId: string,
    ratingId: string,
    patch: Partial<Pick<ReviewPointItem, 'direction' | 'included' | 'stageM' | 'flowM3s'>>
  ): Promise<void> {
    const batch = await db.reviewBatches.get(batchId)
    if (!batch || batch.status !== '进行中') return
    const items = batch.items.map((item) => {
      if (item.ratingId !== ratingId) return item
      const next = { ...item, ...patch }
      // 方向改回「不明」时自动排除出定线
      if (next.direction === '不明') next.included = false
      return next
    })
    const evaluation = evaluateBatch({ stationId: batch.stationId, lineNo: batch.lineNo, items })
    await db.reviewBatches.update(batchId, {
      items,
      risingFit: evaluation.risingFit,
      fallingFit: evaluation.fallingFit,
      conflicts: evaluation.conflicts,
      message: evaluation.message,
      updatedAt: Date.now()
    } as never)
  }

  /** 复核是否可以确认：无交叉冲突，且至少一支拟合有效 */
  function confirmability(batch: ReviewBatch): { ok: boolean; reason: string } {
    if (batch.status !== '进行中') return { ok: false, reason: '该批次已结束' }
    if (batch.conflicts.length > 0) {
      return { ok: false, reason: '涨水 / 退水两支在重叠水位交叉，须先剔除矛盾测次或调整分支' }
    }
    const included = batch.items.filter((item) => item.included)
    if (included.length === 0) return { ok: false, reason: '没有纳入任何点据，无法定线' }
    if (!batch.risingFit?.valid && !batch.fallingFit?.valid) {
      return { ok: false, reason: '涨水 / 退水两支均不足 3 点，无法定线' }
    }
    // 正式发布的曲线必须单调增（b > 0）；b ≤ 0 仅用于交叉检测，须先剔除矛盾点
    const badBranch = [batch.risingFit, batch.fallingFit].find((fit) => fit?.valid && fit.b <= 0)
    if (badBranch) {
      return { ok: false, reason: `${badBranch.branch}支指数 b=${badBranch.b} ≤ 0，水位升高而流量减小，不能作为正式绳套曲线，请先剔除矛盾测次` }
    }
    return { ok: true, reason: '' }
  }

  /**
   * 确认复核：采纳 items 的新值 → 点据转已确认 → 旧曲线留痕失效 →
   * 提交版本 +1 的新曲线 → 按新曲线重算比测。
   */
  async function confirmReview(batchId: string, operator?: string): Promise<{ ok: boolean; reason: string; curve: RatingCurve | null }> {
    const batch = await db.reviewBatches.get(batchId)
    if (!batch) return { ok: false, reason: '复核批次不存在', curve: null }
    const check = confirmability(batch)
    if (!check.ok) return { ok: false, reason: check.reason, curve: null }

    const now = Date.now()
    const iso = new Date(now).toISOString()

    const result = await db.transaction(
      'rw',
      [db.ratings, db.ratingCurves, db.reviewBatches, db.compares],
      async () => {
        // 1) 采纳复核采用值，点据转已确认并解除批次占用
        for (const item of batch.items) {
          const patch: Partial<Rating> = {
            stageM: item.stageM,
            flowM3s: item.flowM3s,
            direction: item.direction,
            status: item.included ? '已确认' : '待确认',
            snapshotStale: false,
            reviewBatchId: null,
            updatedAt: now
          }
          await db.ratings.update(item.ratingId, patch as never)
        }

        // 2) 旧曲线整体留痕失效（不覆盖删除）
        if (batch.touchedCurveIds.length > 0) {
          await db.ratingCurves
            .where('id')
            .anyOf(batch.touchedCurveIds)
            .modify((curve: RatingCurve) => {
              curve.status = '已失效'
              curve.invalidatedAt = iso
              curve.invalidateReason = `复核批次 ${batchId} 确认后由新版本替代`
              curve.updatedAt = now
            })
        }

        // 3) 提交新版本曲线
        const latestVersion = await db.ratingCurves
          .where('stationId')
          .equals(batch.stationId)
          .toArray()
        const sameLine = latestVersion.filter((curve) => curve.lineNo === batch.lineNo)
        const nextVersion = (sameLine.reduce((max, curve) => Math.max(max, curve.version), 0) || 0) + 1
        const curveId = createId('crv')
        const updatedRatings = await db.ratings.toArray()
        // 先暂存新曲线（用于比测），稍后回填 supersededBy
        const newCurve = buildRatingCurve({
          id: curveId,
          stationId: batch.stationId,
          lineNo: batch.lineNo,
          version: nextVersion,
          ratings: updatedRatings,
          confirmedBy: operator ?? batch.operator,
          confirmedAt: iso,
          reviewBatchId: batchId,
          now
        })
        await db.ratingCurves.put(newCurve)
        if (batch.touchedCurveIds.length > 0) {
          await db.ratingCurves
            .where('id')
            .anyOf(batch.touchedCurveIds)
            .modify((curve: RatingCurve) => {
              curve.supersededByCurveId = curveId
            })
        }

        // 4) 按当前全部已确认曲线重算比测（已确认曲线与比测结果保留）
        const allCurves = await db.ratingCurves.toArray()
        const allRatings = await db.ratings.toArray()
        const existingCompares = await db.compares.toArray()
        const rebuilt = rebuildComparesForCurves(allRatings, allCurves, {
          now,
          keep: existingCompares
        })
        // 仅清理受本站线影响的比测，再写入重算结果，其余站线比测原样保留
        const affectedRatingIds = new Set(allRatings.filter((r) => r.stationId === batch.stationId && r.lineNo === batch.lineNo).map((r) => r.id))
        const retained = existingCompares.filter((compare) => !affectedRatingIds.has(compare.ratingId))
        const fresh = rebuilt.filter((compare) => affectedRatingIds.has(compare.ratingId))
        await db.compares.bulkPut([...retained, ...fresh])

        await db.reviewBatches.update(batchId, {
          status: '已确认',
          conflicts: [],
          message: `复核确认：${batch.lineNo} 线已发布 v${nextVersion}`,
          finishedAt: iso,
          updatedAt: now
        } as never)
        return newCurve
      }
    )
    return { ok: true, reason: '', curve: result }
  }

  /**
   * 一批复核失败 → 回滚到批次开始时上次确认的测次：
   * 恢复各点据状态 / 方向 / 旧值、恢复旧曲线为已确认（新版本不产生），
   * 已确认曲线与比测结果保留；批次标记已回滚。
   */
  async function rollbackReview(batchId: string): Promise<boolean> {
    const batch = await db.reviewBatches.get(batchId)
    if (!batch || batch.status !== '进行中') return false
    const now = Date.now()
    const iso = new Date(now).toISOString()

    await db.transaction(
      'rw',
      [db.ratings, db.ratingCurves, db.reviewBatches, db.compares],
      async () => {
        for (const [ratingId, snapshot] of Object.entries(batch.rollback)) {
          await db.ratings.update(ratingId, {
            status: snapshot.status as RatingPointStatus,
            direction: snapshot.direction as TrendDirection,
            stageM: snapshot.stageM,
            flowM3s: snapshot.flowM3s,
            snapshotStale: snapshot.snapshotStale,
            reviewBatchId: snapshot.reviewBatchId,
            updatedAt: now
          } as never)
        }
        // 旧曲线恢复为已确认（回滚不产生新版本）
        if (batch.touchedCurveIds.length > 0) {
          await db.ratingCurves
            .where('id')
            .anyOf(batch.touchedCurveIds)
            .modify((curve: RatingCurve) => {
              // 仅当当前仍是被本批次失效、且未被其它版本替代时才恢复
              if (curve.status === '已失效' && !curve.supersededByCurveId) {
                curve.status = '已确认'
                curve.invalidatedAt = null
                curve.invalidateReason = ''
                curve.updatedAt = now
              }
            })
          // 按恢复后的曲线重建本站线比测
          const allCurves = await db.ratingCurves.toArray()
          const allRatings = await db.ratings.toArray()
          const existingCompares = await db.compares.toArray()
          const rebuilt = rebuildComparesForCurves(allRatings, allCurves, { now, keep: existingCompares })
          const affectedRatingIds = new Set(
            allRatings
              .filter((r) => r.stationId === batch.stationId && r.lineNo === batch.lineNo)
              .map((r) => r.id)
          )
          const retained = existingCompares.filter((compare) => !affectedRatingIds.has(compare.ratingId))
          const fresh = rebuilt.filter((compare) => affectedRatingIds.has(compare.ratingId))
          await db.compares.bulkPut([...retained, ...fresh])
        }
        await db.reviewBatches.update(batchId, {
          status: '已回滚',
          conflicts: [],
          message: '复核失败，已恢复到上次确认的测次，已确认曲线与比测保留',
          finishedAt: iso,
          updatedAt: now
        } as never)
      }
    )
    return true
  }

  /** 放弃（删除）一个进行中批次：点据回到发起前状态，等价于不做任何更改 */
  async function discardReview(batchId: string): Promise<void> {
    const batch = await db.reviewBatches.get(batchId)
    if (!batch || batch.status !== '进行中') return
    await db.transaction('rw', [db.ratings, db.reviewBatches], async () => {
      for (const [ratingId, snapshot] of Object.entries(batch.rollback)) {
        await db.ratings.update(ratingId, {
          status: snapshot.status,
          direction: snapshot.direction,
          stageM: snapshot.stageM,
          flowM3s: snapshot.flowM3s,
          snapshotStale: snapshot.snapshotStale,
          reviewBatchId: null,
          updatedAt: Date.now()
        } as never)
      }
      await db.reviewBatches.delete(batchId)
    })
  }

  /** 待确认（缺来源 / 方向不明）点据直接人工确认后，纳入下一轮复核或直接发起 */
  async function startReviewForPending(stationId: string, lineNo: string, operator?: string): Promise<ReviewBatch> {
    return startReview(stationId, lineNo, { operator })
  }

  /** 当前可直接用于定线的已确认点据（供只读拟合兜底） */
  function confirmedUsableRatings(stationId: string, lineNo: string): Rating[] {
    return ratings.value.filter(
      (rating) =>
        rating.stationId === stationId &&
        rating.lineNo === lineNo &&
        isPointUsableForCurve(rating)
    )
  }

  function curveUsable(curve: RatingCurve): boolean {
    return curveHasValidBranch(curve)
  }

  return {
    ratings,
    curves,
    batches,
    compares,
    sections,
    verticals,
    points,
    ready,
    openBatches,
    stationLineStatus,
    start,
    activeCurve,
    curveHistory,
    openBatch,
    batchOfRating,
    invalidateSection,
    evaluateBatch,
    startReview,
    startReviewForPending,
    refreshSnapshot,
    updateReviewItem,
    confirmability,
    confirmReview,
    rollbackReview,
    discardReview,
    confirmedUsableRatings,
    curveUsable
  }
})
