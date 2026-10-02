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
| 路由 | Vue Router 4（6 条业务路由 + 404） |
| 状态 | Pinia（ringStore / measureStore / reviewStore / siteStore / sessionStore） |
| 量度 | 环志组现场原始值与资料室复核结论两侧分离（morphs / reviews / baselines / reviewOutbox） |
| 地图 | 高德地图 JS API（可选，按需动态加载）+ 本地 SVG 网格退化视图 |
| 存储 | IndexedDB（Dexie，库名 `gbbirdring-db`，schema v3） |
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
│       ├── types/             # ring-record / morphometrics（含复核、按季均线）/ bird-site / session（+ ui.ts）
│       ├── stores/            # ringStore / measureStore（环志组）/ reviewStore（资料室）/ siteStore / sessionStore
│       ├── components/common/ # SiteMap / MeasureInput / RingCodeInput / SpeciesPicker / StatBadge / FilterBar / EmptyPanel
│       ├── hooks/             # useSiteFilter / useAmap
│       ├── pages/             # RingBoard / RingList / MeasureEntry（现场量度）/ ReviewDesk（资料室复核）/ SiteList / SessionList
│       ├── router/index.ts    # 路由表
│       └── utils/             # stats.ts（均线 + 标准差偏离）/ geo.ts / db.ts / export.ts（+ seed.ts / id.ts / plain.ts / format.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 统计台 | 鸟种数、初捕/重捕比、鸟点分布图、鸟种计数与生境分布 |
| `/rings` | 环志记录 | 金属环号 + 彩环双段录入与自动查重，重复时提示并跳转历史记录 |
| `/measure` | 现场量度（环志组） | 环志组录入 6 项现场原始数值，录入后锁定不可改；与同鸟种当季均线比对，同时给出均线偏离（%）与统计偏离（σ） |
| `/review` | 资料室复核 | 复核结论（维持原值 / 存疑 / 复测 / 已修正 / 两边不符）、另存修正值、按季核定均线、两边不符待确认、提交失败重试 |
| `/sites` | 鸟点台账 | 地图 / SVG 网格双模式切换，表单拾取坐标即时落点，点位间距提示 |
| `/sessions` | 调查批次 | 观测条件录入，关闭批次后统计鸟种数、初捕数与重捕数 |

## 量度两侧分离规则

现场量度与资料室复核分成两侧，互不覆盖：

- **环志组（`/measure`，`morphs` 表）**：只管现场测得的原始数值。录入即锁定，不提供「改数」操作；确需更正由资料室在复核侧另存修正值，原始数值照原样留着。删除现场记录会一并撤回其复核单。
- **资料室（`/review`，`reviews` 表）**：只管复核结论 —— 维持原值 / 存疑 / 复测 / 已修正 / 两边不符；存疑项与复测项、复核说明都写在这一侧；更正时把修正值另存在 `corrected`（只存被改的量度项），不写 `morphs`。
- **偏离同时算两个值**：均线偏离（相对同鸟种当季均值的百分比）与统计偏离（距离均值多少个样本标准差，z 值/σ）。
- **均线按季核定（`baselines` 表）**：同鸟种均线由资料室按季核定；核定前页面显示按原始数据（已修正记录用修正值）试算的均值 ± 标准差，核定后以核定单为准。核定后，该鸟种当季**还没定论**的复核自动打上「重新比对」标记；**已定了论**（维持原值 / 已修正）的结论保存均线快照，结论与现场原始数值都不动。
- **两边对不上**：复核侧修正值与现场原始值不一致、或被标记「两边不符」的记录，统一列在复核台「两边不符待确认」页签，等人确认后才转为「维持原值 / 已修正」定论。
- **提交失败重试（`reviewOutbox` 表）**：复核结论写入本地存储失败时转入发件箱队列，不丢失、不阻塞，复核台顶部可一键重试或移除。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbbirdring-db`），表：`rings`、`morphs`（现场原始值）、`reviews`（复核结论）、`baselines`（按季均线）、`reviewOutbox`（提交失败重试）、`sites`、`sessions`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2)` 为环志表增加 `[speciesCn+ringDate]` 复合索引并回填历史彩环字段；`db.version(3)` 把现场量度与资料室复核拆成两侧，新增 `reviews` / `baselines` / `reviewOutbox` 三表。**v3 升级时旧的量度记录一律视为现场原始数值保留在 `morphs`，并为每条补建一份「待复核」复核单**，资料室侧不带任何历史结论。导入 v2 及以前的备份时同样按此规则拆两侧。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入示例数据（6 个鸟点、4 个调查批次、18 条环志记录、14 条现场量度，以及对应的复核结论与 2 份按季核定均线）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
