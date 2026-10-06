/** 演示：建模型 -> 追加观测 -> 预测 -> 派生版本改一条观测对比预测差异。 */
import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "./db";

const DB_PATH = path.join(__dirname, "..", "data", "demo.db");
fs.rmSync(DB_PATH, { force: true });
const store = new Store(DB_PATH);

function show(title: string, x: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(x, null, 2));
}

// 1. 已知样例：m=2, l=10, b=0, season=[2,-2], phase=0, 参数全 0.5
const m1 = store.createModel({ name: "样例", m: 2, l: 10, b: 0, season: [2, -2], phase: 0, alpha: 0.5, beta: 0.5, gamma: 0.5 });
show("创建模型", m1);
const r1 = store.appendBatch(m1.id, [12, 8], "demo-batch-1");
show("追加 [12, 8] 后状态（应不变）", r1.model);
show("每步明细（含一步预测与误差）", r1.steps);
show("未来 3 步预测（应为 12, 8, 12）", store.forecast(m1.id, 3));

// 2. 带趋势、相位不从 0 开始的例子
const m2 = store.createModel({ name: "趋势例", m: 4, l: 100, b: 2, season: [5, -3, -4, 2], phase: 2, alpha: 0.4, beta: 0.2, gamma: 0.6 });
const r2 = store.appendBatch(m2.id, [98, 105, 110, 99, 103]);
show("趋势例：5 步明细", r2.steps);
show("趋势例：未来 8 步（跨两个周期）", store.forecast(m2.id, 8));

// 3. 派生试验版本：改变一个真实观测，对比预测
const v2 = store.forkModel(m1.id, { name: "样例-改观测" });
store.appendBatch(v2.id, [12, 20], "demo-batch-1"); // 第二条观测从 8 改成 20
show("原版本预测", store.forecast(m1.id, 4));
show("改观测版本预测（原版本保留可比较）", store.forecast(v2.id, 4));

// 4. 快照与导出
store.saveSnapshot(m1.id, "训练完成", 4);
show("导出模型 1", store.exportModel(m1.id));

store.close();
console.log(`\n演示数据库: ${DB_PATH}`);
