# 加法 Holt-Winters 状态更新与季节预测核验后端

TypeScript + Node.js + SQLite（`node:sqlite` 内置模块，零运行时依赖）实现的等间隔序列加法 Holt-Winters 服务。只做后端：HTTP API 与 CLI，无前端、无 Docker、无外部在线服务。

## 模型公式

对每条观测 `y`，设当前相位槽位的旧季节值为 `s = season[phase]`：

```
lNew = alpha * (y - s)      + (1 - alpha) * (l + b)
bNew = beta  * (lNew - l)   + (1 - beta)  * b
sNew = gamma * (y - lNew)   + (1 - gamma) * s
```

- 三个公式严格按上述顺序使用新旧状态：水平用旧季节槽、趋势用新水平减旧水平、季节用新水平。
- 更新季节槽是在水平计算完成之后；同一步内不会先用新槽值参与水平更新。
- 每处理一条观测，相位 `phase = (phase + 1) mod m` 前进一步。

未来第 `h` 步预测（`h` 从 1 开始，只读、不反写状态）：

```
forecast(h) = l + h * b + season[(phase + h - 1) mod m]
```

即从**下一相位**开始循环取第 `h` 个季节项；跨多个周期仍按模 `m` 循环。`phase` 始终是"下一条观测/下一步预测将使用的槽位"，不是上次处理过的槽位。

每步记录的一步预测为更新前的 `l + b + sOld`，误差 `err = y - oneStep`。**这是训练期一步拟合误差，不等于真实未来预测精度**；本系统不提供统计置信区间。

## 边界与假设

- 只做加法模型：不因数据正负切换乘法公式；初始化后不重新归一化季节项。
- 初始 `l`、`b`、季节数组、相位全部由用户给定；不自动拟合初值、不搜索最优参数。
- 只处理等间隔序列；不做缺失值插补。
- 允许负观测、负趋势、零平滑参数；负预测不截零。
- 周期 `m ∈ [2, 24]`；`alpha/beta/gamma ∈ [0, 1]`；`phase ∈ [0, m)`；季节数组长度必须等于 `m`。
- 所有输入与中间结果必须有限，出现 `NaN`/`Infinity`（如溢出）立即失败并回滚整批。
- 上限（`GET /config` 可查）：单批观测 10000、单次预测 1000 步、单模型累计观测 1,000,000。

## 持久化与一致性

SQLite 保存：初始状态、当前状态、完整观测序列（每步的新旧量与一步误差）、参数版本、批次幂等键、快照。

- 一批观测在单个事务中写入，失败批次不留部分槽位更新。
- 追加观测可带 `idempotencyKey`：重复请求直接返回首次结果，不重复消费观测。
- 相同观测分多批提交与一次提交结果一致；重启服务后从数据库恢复相位继续。
- `fork` 创建独立试验版本（复制初始状态、版本号 +1、可覆盖平滑参数），不重放旧观测，也不用新参数解释旧报告。

## 运行

要求：Node.js ≥ 22（使用内置 `node:sqlite`），Windows 本地直接运行。

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认自动选择空闲端口；--port 8080 或 PORT 环境变量指定）
npm run demo       # 演示：建模 -> 追加 -> 预测 -> 改观测派生版本对比
```

数据库默认在项目内 `data/hw.db`，可用环境变量 `HW_DB` 覆盖。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/config` | 周期/参数/批量上限 |
| POST | `/models` | 建模：`{m,l,b,season,phase,alpha,beta,gamma,name?}` |
| GET | `/models` / `/models/:id` | 列表 / 当前状态 |
| POST | `/models/:id/observations` | 追加批次：`{values:[...], idempotencyKey?}`，返回每步新旧量 |
| GET | `/models/:id/steps?from=&to=` | 逐步历史（含一步预测与误差） |
| POST | `/models/:id/forecast` | 预测：`{h}`，只读 |
| POST | `/models/:id/fork` | 派生版本：`{alpha?,beta?,gamma?,name?}` |
| POST | `/models/:id/snapshots` | 保存快照：`{label,h}` |
| GET | `/models/:id/snapshots` | 快照列表 |
| GET | `/models/:id/export` | 导出模型+历史+快照 JSON |

错误统一返回 `{"error": 错误码, "message": 中文说明}`，HTTP 400。错误码：`INVALID_PERIOD`、`INVALID_SMOOTHING`、`INVALID_SEASON`、`INVALID_PHASE`、`NON_FINITE`、`INVALID_HORIZON`、`EMPTY_BATCH`、`BATCH_TOO_LARGE`、`TOO_MANY_OBS`、`MODEL_NOT_FOUND`、`BAD_JSON`、`BAD_ID`、`NOT_FOUND`。

## CLI

```powershell
node dist/src/cli.js create --m 2 --l 10 --b 0 --season 2,-2 --phase 0 --alpha 0.5 --beta 0.5 --gamma 0.5
node dist/src/cli.js append --model 1 --values 12,8 --key batch-1
node dist/src/cli.js state --model 1
node dist/src/cli.js steps --model 1 --from 0 --to 9
node dist/src/cli.js forecast --model 1 --h 3
node dist/src/cli.js fork --model 1 --alpha 0.3
node dist/src/cli.js snapshot --model 1 --label v1 --h 12
node dist/src/cli.js export --model 1
node dist/src/cli.js list
```

## 已知样例

`m=2, l=10, b=0, season=[2,-2], phase=0, alpha=beta=gamma=0.5`，依次输入 `12, 8`：状态不变，未来预测为 `12, 8, 12`。测试中还包含带趋势、相位非零的手算例（`m=4, l=100, b=2, season=[5,-3,-4,2], phase=2`），逐步与独立参考实现对照。

## 已知限制

- 单进程服务，无鉴权，面向本机核验用途。
- `node:sqlite` 在 Node 25 仍标记为实验特性（启动时有 ExperimentalWarning，不影响功能）。
- 不提供置信区间、参数寻优、乘法模型、不等间隔或缺失值处理。
