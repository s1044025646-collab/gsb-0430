# 加法 Holt–Winters 状态更新与季节预测核验后端

TypeScript + Node.js + SQLite（`node:sqlite` 内置模块，无原生编译依赖）。仅 API 与 CLI，Windows 本地运行，不需要 Docker / WSL / 外部服务。

## 模型与公式

等间隔序列的**加法** Holt–Winters。状态为水平 `l`、趋势 `b`、长度 `m` 的季节数组 `s[]` 与下一相位 `phase`（取值 `0..m-1`，指向 `s` 中下一个要使用的槽位）。

每来一条观测 `y`，先取出**当前槽旧值** `sOld = s[phase]`，再按序递推（注意各项使用的新旧状态）：

```
lNew = alpha*(y - sOld)   + (1-alpha)*(l + b)    # 用旧季节槽、旧水平、旧趋势
bNew = beta *(lNew - l)   + (1-beta )*b          # 用新水平与旧水平之差
sNew = gamma*(y - lNew)   + (1-gamma)*sOld       # 用新水平，写回同一槽位
```

随后 `phase = (phase + 1) mod m`。实现中先算完三个新值再写回，不会出现"更新水平后丢掉旧水平"或"先改季节槽再算水平"。

每步的一步预测（处理该观测**之前**）为 `l + b + sOld`，残差 `y - (l+b+sOld)` 会逐条记录。**这是训练期拟合误差，不等于真实未来预测精度**；本项目不实现置信区间。

处理完 N 条观测后，未来第 h 步（h 从 1 开始）预测：

```
yhat(h) = l + h*b + s[(phase + h - 1) mod m]
```

即从**下一相位**开始循环取第 h 个季节项；跨多个周期仍正确循环。预测只读状态，不会把预测值当作观测回写模型。

## 边界与假设

- `m ∈ [2, 24]`；`alpha/beta/gamma ∈ [0, 1]`（允许 0 和 1）；`phase ∈ [0, m)` 整数。
- 初始 `l, b, s[], phase` 全部由用户显式给定：**不自动拟合初值、不搜索最优参数、初始化后不重新归一化季节项**。
- 纯加法模型：不按数据正负切换乘法公式；允许负观测、负趋势、负预测（不截断为零）。
- 不处理不等间隔时间与缺失值插补。
- 所有输入与中间结果必须有限，溢出（得到 `Infinity/NaN`）立即失败并回滚整批。
- 上限：单批观测 10000 条，预测步数 1000，累计历史 1000000 条（见 `src/hw.ts` 常量）。
- 参数修改通过创建新模型/试验版本完成（`parentId` 关联），不用新参数解释旧报告；旧版本与快照保留可比较。
- 批提交原子化（SQLite 事务）；可选 `requestId` 幂等，重复请求直接返回首次结果，不重复消费观测。

## 错误码

`PARAM_RANGE` 平滑参数越界 · `BAD_M` 季节长度非法 · `BAD_PHASE` 相位非法 · `NON_FINITE` 非有限数 · `EMPTY_BATCH`/`BATCH_TOO_LARGE`/`HISTORY_FULL` 批量限制 · `BAD_HORIZON` 预测步数非法 · `NO_MODEL`/`MODEL_EXISTS` 模型不存在/已存在 · `NOT_FOUND`/`INTERNAL`

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 编译并运行 node:test 测试（10 个用例）
npm start         # 启动 API，默认自动选空闲端口（PORT=8080 npm start 指定端口）
npm run demo      # 演示：追加一轮观测 -> 快照 -> 改一条观测建 v2 对比预测
```

数据目录为项目内 `data/`（可用环境变量 `HW_DB` 指定数据库文件）。

## CLI

```
node dist/cli.js serve [port]
node dist/cli.js create <id> <l> <b> <sJson> <phase> <alpha> <beta> <gamma> [name] [parentId]
node dist/cli.js append <id> <yJsonArray> [requestId]
node dist/cli.js state|list|history <id>
node dist/cli.js forecast <id> <h>
node dist/cli.js snapshot <id> [label]
node dist/cli.js export <id>
```

例：`node dist/cli.js create m1 10 0 "[2,-2]" 0 0.5 0.5 0.5` → `node dist/cli.js append m1 "[12,8]"` → `node dist/cli.js forecast m1 3` 得 `[12, 8, 12]`。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/models` | 建模 `{id,l,b,s,phase,params:{alpha,beta,gamma},name?,parentId?}` |
| GET | `/models` / `/models/:id` | 列表 / 当前状态（含下一相位） |
| POST | `/models/:id/observations` | 追加一批 `{y:[...], requestId?}`，原子提交，返回每步新旧量 |
| GET | `/models/:id/history` | 每步一步预测、残差、旧槽位、新旧状态 |
| GET | `/models/:id/observations` | 完整观测序列 |
| GET | `/models/:id/forecast?h=N` | 未来 1..N 步预测（只读） |
| POST/GET | `/models/:id/snapshots` | 保存 / 读取结果快照 |
| GET | `/models/:id/export` | 导出模型+观测+历史 JSON |

## 已知样例

`m=2, l=10, b=0, s=[2,-2], phase=0, alpha=beta=gamma=0.5`，依次输入 `12, 8` 后状态不变，未来三步预测为 `12, 8, 12`（测试与演示均覆盖）。

## 已知限制

- `node:sqlite` 在 Node 25 仍标记 experimental（启动时有警告），API 稳定前建议锁定 Node 版本。
- 单进程服务，无鉴权，仅监听本地回环地址使用。
