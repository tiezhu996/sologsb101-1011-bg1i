<script setup lang="ts">
/**
 * 绳套复核面板：一批复核的试算与确认 / 回滚。
 * - 按涨水 / 退水两支分别拟合，显示各自参数与残差；
 * - 水位重叠且两支交叉的测次先列冲突，冲突未处理禁止确认；
 * - 快照脱节的点据可「采用最新测次成果」刷新，旧值与新值并列展示；
 * - 一批复核失败可回滚到上次确认的测次，已确认曲线与比测保留。
 */
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, RefreshLeft, Warning } from '@element-plus/icons-vue'
import type { ReviewBatch } from '@/types/review'
import type { TrendDirection } from '@/types/rating'
import { TREND_DIRECTIONS } from '@/types/rating'
import { useReviewStore } from '@/stores/reviewStore'

const props = defineProps<{ batch: ReviewBatch }>()

const reviewStore = useReviewStore()
const busy = ref(false)

  const batch = computed(() => props.batch)

  const rising = computed(() => batch.value.risingFit)
  const falling = computed(() => batch.value.fallingFit)

  const risingPoints = computed(() => batch.value.items.filter((item) => item.included && item.direction === '涨水'))
  const fallingPoints = computed(() => batch.value.items.filter((item) => item.included && item.direction === '退水'))
  const excludedPoints = computed(() => batch.value.items.filter((item) => !item.included || item.direction === '不明'))

  const confirmCheck = computed(() => reviewStore.confirmability(batch.value))

  const changedItems = computed(() =>
    batch.value.items.filter(
      (item) =>
        Math.abs(item.stageM - item.previousStageM) > 1e-6 ||
        Math.abs(item.flowM3s - item.previousFlowM3s) > 1e-6
    )
  )

  async function refreshOne(ratingId: string): Promise<void> {
    busy.value = true
    try {
      await reviewStore.refreshSnapshot(batch.value.id, ratingId)
      ElMessage.success('已按来源测次最新成果刷新流量快照')
    } finally {
      busy.value = false
    }
  }

  async function setDirection(ratingId: string, direction: TrendDirection): Promise<void> {
    await reviewStore.updateReviewItem(batch.value.id, ratingId, {
      direction,
      included: direction !== '不明'
    })
  }

  async function toggleIncluded(ratingId: string, included: boolean): Promise<void> {
    await reviewStore.updateReviewItem(batch.value.id, ratingId, { included })
  }

  async function editAdoptedValue(ratingId: string, field: 'stageM' | 'flowM3s', raw: number): Promise<void> {
    if (!Number.isFinite(raw)) return
    await reviewStore.updateReviewItem(batch.value.id, ratingId, { [field]: raw })
  }

  async function confirm(): Promise<void> {
    if (!confirmCheck.value.ok) {
      ElMessage.warning(confirmCheck.value.reason)
      return
    }
    try {
      await ElMessageBox.confirm(
        `确认后将发布新版本绳套曲线，旧版本保留留痕；采纳 ${changedItems.value.length} 个更新后的测次值。确认提交？`,
        '确认复核',
        { type: 'warning', confirmButtonText: '确认发布新版本', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
    busy.value = true
    try {
      const result = await reviewStore.confirmReview(batch.value.id)
      if (!result.ok) {
        ElMessage.error(`复核未通过：${result.reason}`)
        return
      }
      ElMessage.success(`复核通过，已发布 ${batch.value.lineNo} 线 v${result.curve?.version ?? ''}`)
    } finally {
      busy.value = false
    }
  }

  async function rollback(): Promise<void> {
    try {
      await ElMessageBox.confirm(
        '本批复核失败：将放弃所有试算与改动，恢复到上次确认的测次；已确认曲线与比测结果保留。确认回滚？',
        '回滚复核',
        { type: 'warning', confirmButtonText: '回滚到上次确认', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
    busy.value = true
    try {
      await reviewStore.rollbackReview(batch.value.id)
      ElMessage.success('已恢复到上次确认的测次')
    } finally {
      busy.value = false
    }
  }

  async function discard(): Promise<void> {
    try {
      await ElMessageBox.confirm('放弃本次复核？点据将回到发起前状态，不产生任何更改。', '放弃复核', {
        type: 'info',
        confirmButtonText: '放弃',
        cancelButtonText: '继续复核'
      })
    } catch {
      return
    }
    busy.value = true
    try {
      await reviewStore.discardReview(batch.value.id)
      ElMessage.info('已放弃本次复核')
    } finally {
      busy.value = false
    }
  }
</script>

<template>
  <el-card shadow="never" class="review-panel">
    <div class="review-panel__head">
      <div>
        <h3 class="review-panel__title">
          复核批次 · {{ batch.lineNo }} 线
          <el-tag size="small" type="warning" effect="dark">进行中</el-tag>
          <el-tag v-if="batch.baselineCurveId" size="small" type="info" effect="plain">基于上一确认版本重算</el-tag>
          <el-tag v-else size="small" type="info" effect="plain">首次定线</el-tag>
        </h3>
        <p class="gb-hint">复核人 {{ batch.operator || '—' }} · 发起于 {{ new Date(batch.createdAt).toLocaleString('zh-CN') }}</p>
      </div>
      <div class="review-panel__actions">
        <el-button :icon="RefreshLeft" :loading="busy" @click="rollback">复核失败·回滚</el-button>
        <el-button :loading="busy" @click="discard">放弃</el-button>
        <el-button type="primary" :icon="CircleCheck" :disabled="!confirmCheck.ok" :loading="busy" @click="confirm">
          确认并发布新版本
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="batch.conflicts.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="review-panel__alert"
      title="涨水 / 退水两支在重叠水位交叉，冲突测次须先处理"
    >
      <div v-for="(conflict, index) in batch.conflicts" :key="index" class="review-panel__conflict">
        <el-icon><Warning /></el-icon>
        <span>{{ conflict.message }}</span>
      </div>
      <p class="gb-hint">处理方式：在下方点据表剔除矛盾测次，或把点据改派到另一分支后，系统会重新检测。</p>
    </el-alert>
    <el-alert
      v-else-if="!confirmCheck.ok"
      type="warning"
      show-icon
      :closable="false"
      :title="confirmCheck.reason"
      class="review-panel__alert"
    />
    <el-alert
      v-else
      type="success"
      show-icon
      :closable="false"
      title="两支无交叉，拟合有效，可以确认发布新版本"
      class="review-panel__alert"
    />

    <div class="review-panel__fits">
      <div class="review-panel__fit review-panel__fit--rising">
        <div class="review-panel__fit-title">涨水支</div>
        <template v-if="rising?.valid">
          <div class="gb-mono review-panel__formula">Q = {{ rising.a }}·(H-{{ rising.h0 }})^{{ rising.b }}</div>
          <div class="gb-hint">{{ rising.sampleCount }} 点 · 平均残差 {{ rising.meanResidualPct }}% · 最大 {{ rising.maxResidualPct }}% · R² {{ rising.r2 }}</div>
        </template>
        <div v-else class="gb-hint">{{ rising?.message || '暂无涨水支点据' }}</div>
      </div>
      <div class="review-panel__fit review-panel__fit--falling">
        <div class="review-panel__fit-title">退水支</div>
        <template v-if="falling?.valid">
          <div class="gb-mono review-panel__formula">Q = {{ falling.a }}·(H-{{ falling.h0 }})^{{ falling.b }}</div>
          <div class="gb-hint">{{ falling.sampleCount }} 点 · 平均残差 {{ falling.meanResidualPct }}% · 最大 {{ falling.maxResidualPct }}% · R² {{ falling.r2 }}</div>
        </template>
        <div v-else class="gb-hint">{{ falling?.message || '暂无退水支点据' }}</div>
      </div>
    </div>

    <el-table :data="batch.items" border stripe size="small" class="gb-table-compact">
      <el-table-column label="分支" width="150">
        <template #default="{ row }">
          <el-select
            :model-value="row.direction"
            size="small"
            @change="(value: TrendDirection) => setDirection(row.ratingId, value)"
          >
            <el-option v-for="direction in TREND_DIRECTIONS" :key="direction" :label="direction" :value="direction" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="纳入" width="70" align="center">
        <template #default="{ row }">
          <el-checkbox
            :model-value="row.included"
            :disabled="row.direction === '不明'"
            @change="(value: boolean) => toggleIncluded(row.ratingId, value)"
          />
        </template>
      </el-table-column>
      <el-table-column label="旧水位 (m)" width="100" align="right">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.previousStageM.toFixed(2) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="旧流量" width="100" align="right">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.previousFlowM3s.toFixed(1) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="复核采用水位 (m)" width="140" align="right">
        <template #default="{ row }">
          <el-input-number
            :model-value="row.stageM"
            :step="0.01"
            :precision="2"
            :controls="false"
            size="small"
            class="review-panel__num"
            @change="(value: number) => editAdoptedValue(row.ratingId, 'stageM', value)"
          />
        </template>
      </el-table-column>
      <el-table-column label="复核采用流量" width="140" align="right">
        <template #default="{ row }">
          <el-input-number
            :model-value="row.flowM3s"
            :step="1"
            :precision="1"
            :controls="false"
            size="small"
            class="review-panel__num"
            @change="(value: number) => editAdoptedValue(row.ratingId, 'flowM3s', value)"
          />
        </template>
      </el-table-column>
      <el-table-column label="快照" min-width="120">
        <template #default="{ row }">
          <el-tag v-if="row.snapshotStale" type="danger" size="small" effect="plain">待更新</el-tag>
          <el-tag v-else type="success" size="small" effect="plain">最新</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <el-button
            size="small"
            :disabled="!row.snapshotStale"
            @click="refreshOne(row.ratingId)"
          >
            采用最新测次成果
          </el-button>
        </template>
      </el-table-column>
      <template #empty>本批没有待复核点据</template>
    </el-table>

    <div class="review-panel__summary gb-hint">
      涨水支 {{ risingPoints.length }} 点 · 退水支 {{ fallingPoints.length }} 点 · 排除 / 方向不明
      {{ excludedPoints.length }} 点 · 值有更新 {{ changedItems.length }} 点
    </div>
  </el-card>
</template>

<style scoped>
.review-panel {
  border: 1px solid #e0c080;
}

.review-panel__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.review-panel__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 16px;
  color: #8a5a00;
}

.review-panel__actions {
  display: flex;
  gap: 8px;
}

.review-panel__alert {
  margin-bottom: 12px;
}

.review-panel__conflict {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
}

.review-panel__fits {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}

.review-panel__fit {
  border: 1px solid #d8e4ec;
  border-radius: 6px;
  padding: 10px 12px;
}

.review-panel__fit--rising {
  border-left: 4px solid #c0392b;
}

.review-panel__fit--falling {
  border-left: 4px solid #0f4c75;
}

.review-panel__fit-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.review-panel__formula {
  font-size: 14px;
  margin-bottom: 2px;
}

.review-panel__num {
  width: 100%;
}

.review-panel__summary {
  margin-top: 8px;
}

@media (max-width: 900px) {
  .review-panel__fits {
    grid-template-columns: 1fr;
  }
}
</style>
