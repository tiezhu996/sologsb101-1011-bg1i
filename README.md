# sologsb101-1011 水文站流量测验与绳套曲线台

面向水文站测验与资料整编人员的纯前端单页应用：把每次测流的测站、断面测次、垂线测深、流速测点逐层落档，据此整理水位—流量关系点据完成幂函数定线，并开展比测偏差分析。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22811**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22811），如需换端口改这一个变量即可。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `stationStore` / `sectionStore` / `ratingStore` / `reviewStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbhydrogaug`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 测站台账 | Station、Section、Rating | 新建/编辑/删除测站，按河名与集水面积分档筛选，卡片回显测次数、最新水位与比测合格率 |
| `/stations/:id/sections` | 断面测次列表与测法标记 | Section、Station | 新增测次（测次号、起点距、水位、流速仪/浮标/ADCP），水位筛选，回显当前水位与水位变幅 |
| `/sections/:id/verticals` | 垂线布设与测深 | Vertical、Section | 起点距排序校验（重复即时告警）、按测点数自动生成测点行、部分面积法断面流量成果 |
| `/verticals/:id/points` | 流速测点录入 | Point、Vertical | 逐点录入相对水深与流速、批量粘贴导入、批量改写流速、权重归一、垂线流速分布图 |
| `/ratings` | 水位流量关系点据与绳套定线 | Rating、RatingCurve、ReviewBatch、Compare | 点据落档带来源断面/垂线/测点与流量快照，涨水/退水两支版本化定线；测次更新后旧曲线失效，复核试算/交叉冲突/确认/回滚 |
| `/export` | 比测偏差分析与导出 | 全部模型 | 按测站出检测结论、比测偏差分析清单、全量 JSON 导入导出（含溯源/状态/曲线版本）、清空重建演示数据 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1011/
├── README.md
├── docker-compose.yml          # name: gbhydrogaug，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # station / section / vertical / point / rating / curve / review / compare / filter
        ├── stores/             # stationStore / sectionStore / ratingStore / reviewStore
        ├── components/common/  # DeviationTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── components/rating/  # ReviewPanel（复核试算/冲突/确认/回滚）/ ProvenanceTag（来源与快照）
        ├── hooks/              # useIdbTable / useRatingFit
        ├── pages/              # StationList / SectionList / VerticalBoard / PointEntry / RatingChart / ExportView
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── scripts/            # verify-rating-workflow.ts / verify-upgrade-export.ts（fake-indexeddb 逻辑自检）
        ├── styles/main.css
        └── utils/              # flow.ts / db.ts / export.ts / provenance.ts（来源快照与方向推断）/ curveOps.ts（曲线组装/失效/比测）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22811
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbhydrogaug`，当前结构版本 `v3`。页面侧由 `frontend/src/utils/db.ts` 统一封装，页面组件不直接触碰 Dexie 实例。
- **数据表（八张）**：`stations`（测站）、`sections`（断面测次）、`verticals`（垂线）、`points`（流速测点）、`ratings`（水位流量关系点据，含来源断面 / 垂线 / 测点指针、流量快照、涨退方向与复核状态）、`ratingCurves`（每站×定线号的版本化绳套曲线，涨 / 退两支参数）、`reviewBatches`（复核批次：试算两支、交叉冲突、确认 / 回滚快照）、`compares`（比测记录，挂曲线版本与分支）。
- **可追溯绳套定线**：
  - 每个关系点据记住**来源断面、垂线、测点**与落档时的**流量快照**（水位、流量、面积、平均流速、垂线 / 测点数、抓取时间）。
  - 原始测次**补录或重测**（改测次、垂线、测点成果）后，点据仍按旧值保留、标记「快照待更新 / 待复核」，其已确认绳套曲线**先失效**（不覆盖），经复核后才发布新版本。
  - 复核按**涨水、退水两支分别拟合**幂函数；水位重叠区内两支交叉的测次**先列冲突**，冲突未处理禁止确认；一批复核失败可**回滚到上次确认的测次**，已确认曲线与比测结果保留。
  - 曲线按版本留痕：旧版本置「已失效」并登记被哪个新版本替代（`supersededByCurveId`），不删除、不覆盖。
- **升级迁移**：`db.version(2)` 补筛选索引；`db.version(3).upgrade(...)` 为历史点据补来源指针、流量快照与按测次时间序列推断的涨 / 退方向——**缺来源或方向不明的点据留在「待确认」**，不参与定线；调整字段时递增 `DB_VERSION` 并在 `upgrade` 中补迁移。
- **首屏播种**：`initDatabase()` 在 `stations` 表为空时执行幂等播种，生成三层互相引用的演示数据（3 个测站 / 多断面测次 / 垂线 / 测点 / 关系点据 / 版本化绳套曲线 / 比测记录），青矶 B 线为含涨 / 退两支的洪水绳套，白沙 C 线含超限点据用于演示挂红与偏差分析。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，store 里的列表自动刷新，无需手动处理刷新时机。
- **备份与恢复**：`/ratings` 关系点据页维护点据与复核；`/export` 页可导出包含八张表的 JSON 快照（来源、快照、方向、复核状态与曲线版本一并携带），支持「覆盖导入」与「追加导入（重新分配 id 并保持外键一致）」两种模式；导入 v1/v2 旧备份时自动归一化（缺来源 / 方向不明留待确认）。备份时间写入 `localStorage`。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器 / 清空站点数据后数据不会跟随，需通过 JSON 备份迁移。
- **逻辑自检**：`frontend/scripts/` 下提供 `verify-rating-workflow.ts`（失效→复核→交叉→确认 / 回滚）与 `verify-upgrade-export.ts`（v2→v3 迁移、导入导出状态携带），用 `npx vite-node scripts/<name>.ts` 在 fake-indexeddb 上运行。
