<script setup lang="ts">
/**
 * 点据溯源徽标：展示关系点据的来源断面、垂线 / 测点数量与流量快照，
 * 以及快照是否已随测次补录 / 重测而脱节。点击展开明细，供定线与整编追溯。
 */
import { computed } from 'vue'
import { Link, WarningFilled } from '@element-plus/icons-vue'
import type { Rating } from '@/types/rating'

const props = defineProps<{ rating: Rating; sectionMeasureNo?: string | null }>()

const hasSource = computed(() => Boolean(props.rating.sourceSectionId))
const hasSnapshot = computed(() => Boolean(props.rating.snapshot))
const measureLabel = computed(() => props.sectionMeasureNo ?? props.rating.measureNo ?? '未标记测次')
</script>

<template>
  <el-popover placement="top-start" :width="320" trigger="hover">
    <template #reference>
      <el-tag
        :type="rating.snapshotStale ? 'danger' : hasSource ? 'info' : 'warning'"
        size="small"
        effect="plain"
        class="prov-tag"
      >
        <el-icon class="prov-tag__icon">
          <WarningFilled v-if="rating.snapshotStale || !hasSource" />
          <Link v-else />
        </el-icon>
        {{ hasSource ? measureLabel : '缺来源' }}
      </el-tag>
    </template>

    <div class="prov-pop">
      <div class="prov-pop__title">关系点据溯源</div>
      <div class="prov-pop__row"><span>来源测次</span><b>{{ measureLabel }}</b></div>
      <div class="prov-pop__row">
        <span>来源断面</span>
        <b class="gb-mono">{{ rating.sourceSectionId ?? '—（手工 / 历史整编）' }}</b>
      </div>
      <div class="prov-pop__row">
        <span>垂线 / 测点</span>
        <b>{{ rating.sourceVerticalIds.length }} 条 / {{ rating.sourcePoints.length }} 点</b>
      </div>
      <div class="prov-pop__row">
        <span>洪水方向</span>
        <b>{{ rating.direction }}</b>
      </div>
      <template v-if="hasSnapshot">
        <el-divider style="margin: 8px 0" />
        <div class="prov-pop__title">流量快照（定线采用值）</div>
        <div class="prov-pop__row"><span>水位</span><b class="gb-mono">{{ rating.snapshot!.stageM.toFixed(2) }} m</b></div>
        <div class="prov-pop__row"><span>断面流量</span><b class="gb-mono">{{ rating.snapshot!.flowM3s.toFixed(2) }} m³/s</b></div>
        <div class="prov-pop__row">
          <span>面积 / 平均流速</span>
          <b class="gb-mono">{{ rating.snapshot!.areaM2.toFixed(1) }} m² / {{ rating.snapshot!.meanVelocityMs.toFixed(2) }} m/s</b>
        </div>
        <div class="prov-pop__row">
          <span>抓取时间</span>
          <b>{{ new Date(rating.snapshot!.capturedAt).toLocaleString('zh-CN') }}</b>
        </div>
      </template>
      <el-alert
        v-if="rating.snapshotStale"
        type="error"
        :closable="false"
        show-icon
        title="来源测次已补录 / 重测，当前点据仍保留旧值，旧曲线已失效，请进入复核重算"
        class="prov-pop__alert"
      />
      <div v-if="rating.note" class="prov-pop__note">{{ rating.note }}</div>
    </div>
  </el-popover>
</template>

<style scoped>
.prov-tag {
  cursor: default;
}

.prov-tag__icon {
  margin-right: 2px;
}

.prov-pop__title {
  font-weight: 600;
  font-size: 13px;
  color: #0f4c75;
  margin-bottom: 4px;
}

.prov-pop__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  line-height: 1.9;
}

.prov-pop__row span {
  color: #8194a2;
}

.prov-pop__alert {
  margin-top: 8px;
}

.prov-pop__note {
  margin-top: 6px;
  font-size: 12px;
  color: #a07a2a;
}
</style>
