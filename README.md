# 鸟类环志记录与鸟点地图（gbbirdring）

面向环志站与鸟类监测志愿者：登记环志编号、鸟种与量度（喙/翅/尾/体重）、鸟点生境与调查批次，并在地图上查看鸟点分布。地图使用高德地图 JS API（key 走 `VITE_AMAP_KEY`），**未配置 key 时自动退化为本地 SVG 网格视图，构建与运行均不依赖该 key**。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21812>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| 构建 | Vite 6（`npm run build` 含 `vue-tsc --noEmit` 类型检查） |
| UI | Element Plus 2 |
| 路由 | Vue Router 4（5 条业务路由 + 404） |
| 状态 | Pinia（ringStore / measureStore / meanStore / siteStore / sessionStore） |
| 地图 | 高德地图 JS API（可选，按需动态加载）+ 本地 SVG 网格退化视图 |
| 存储 | IndexedDB（Dexie，库名 `gbbirdring-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 地图 key 说明（可选）

- 未配置 `VITE_AMAP_KEY`：`<SiteMap>` 渲染本地 SVG 网格视图，标记按生境配色落在对应格位，表单拾取坐标即落到格位中心；**构建与运行都不依赖该 key**。
- 配置后：`.env` 里填 `VITE_AMAP_KEY=<你的 key>`，再 `docker compose up -d --build`（compose 通过 build args 传入，Dockerfile 用 `ARG VITE_AMAP_KEY` 注入 Vite）。高德控制台需为该访问域名开启 JS API。

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21812
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射 / 可选 VITE_AMAP_KEY build arg
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT、可选 VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # ring-record / morphometrics / species-mean / bird-site / session（+ ui.ts）
│       ├── stores/            # ringStore / measureStore / meanStore / siteStore / sessionStore
│       ├── components/common/ # SiteMap / MeasureInput / RingCodeInput / SpeciesPicker / StatBadge / FilterBar / EmptyPanel
│       ├── hooks/             # useSiteFilter / useAmap
│       ├── pages/             # RingBoard / RingList / MeasureEntry / MeasureReview / SiteList / SessionList
│       ├── router/index.ts    # 路由表
│       └── utils/             # stats.ts / geo.ts / db.ts / export.ts（+ seed.ts / id.ts / plain.ts / format.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 统计台 | 鸟种数、初捕/重捕比、鸟点分布图、鸟种计数与生境分布 |
| `/rings` | 环志记录 | 金属环号 + 彩环双段录入与自动查重，重复时提示并跳转历史记录 |
| `/measure` | 量度测量 | 环志组录入现场原始数值，6 项量度带单位与范围校验，与资料室按季核定均线比对给出偏离提示；复核后原值锁定 |
| `/review` | 量度复核 | 资料室侧：复核结论 / 存疑 / 复测要求写在复核侧，修正值另存不覆盖原值；按季核定鸟种均线（未定论重新比对、已定论不动）；两边对不上的列清单等人确认；提交失败可重试 |
| `/sites` | 鸟点台账 | 地图 / SVG 网格双模式切换，表单拾取坐标即时落点，点位间距提示 |
| `/sessions` | 调查批次 | 观测条件录入，关闭批次后统计鸟种数、初捕数与重捕数 |

## 量度两边分开（环志组 / 资料室）

- **环志组管现场原始数值**：`/measure` 录入喙 / 翅 / 尾 / 跗跖 / 体重与肥满度，复核后不可改；确实要改只能由资料室另存修正值。
- **资料室管复核结论**：`/review` 下结论（确认无误 / 存疑 / 待复测），存疑和复测要求写在复核侧；更正数值走「修正值」，与原值并列显示、不覆盖。
- **均线按季核定**：同鸟种均线由资料室按季核定（依据已定论记录的定论采用值）。核定后还没定论的记录标记「待重新比对」，定了论的结论和原始数值都不动。
- **对不上清单**：存疑 / 待复测 / 有修正值的记录集中列出，等人确认。
- **提交失败重试**：复核提交失败后停在失败态，可重试提交（页内提供「模拟提交失败」开关演示）。
- **旧数据升级**：`db.version(3)` 升级时把原量度按两边拆开——原来的量度算现场原始数值，复核侧补「未复核」结论，原值不动。升级前可用顶栏「导出备份」导出全量 JSON。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbbirdring-db`），表：`rings`、`morphs`、`sites`、`sessions`、`speciesMeans`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为环志表增加 `[speciesCn+ringDate]` 复合索引并回填历史彩环字段；`db.version(3).upgrade(...)` 量度按两边拆开（原量度算现场原始数值、复核侧补未复核结论）并新增 `speciesMeans` 表存季度核定均线。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入示例数据（6 个鸟点、4 个调查批次、18 条环志记录、14 条量度与 1 条季度均线）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
