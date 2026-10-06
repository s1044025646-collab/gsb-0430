/** 演示：建模型 -> 追加一轮观测 -> 快照 -> 改一条观测生成新版本对比预测。 */
import { Store } from './db';
import { forecast } from './hw';
import * as fs from 'node:fs';

const DB = 'data/demo.db';
fs.rmSync(DB, { force: true });
const st = new Store(DB);

const params = { alpha: 0.5, beta: 0.5, gamma: 0.5 };
st.createModel('v1', '原始版本', params, { l: 10, b: 0, s: [2, -2], phase: 0 });
const r1 = st.append('v1', [12, 8, 13, 7, 14, 6], 'demo-batch-1');
console.log('v1 每步:');
for (const r of r1.recs)
  console.log(`  idx=${r.index} 相位=${r.phase} sOld=${r.sOld} 一步预测=${r.oneStepForecast} 实际=${r.y} 残差=${r.residual} -> l=${r.lNew} b=${r.bNew} sNew=${r.sNew}`);
const f1 = Array.from({ length: 4 }, (_, i) => forecast(r1.model.cur, i + 1));
console.log('v1 未来4步预测:', f1);
st.snapshot('v1', '训练完成基线', { model: st.getModel('v1') });

// 改变第 5 条观测（14 -> 20），从同一初始状态建独立版本 v2
st.createModel('v2', '修改观测版本', params, { l: 10, b: 0, s: [2, -2], phase: 0 }, 'v1');
const ys2 = [12, 8, 13, 7, 20, 6];
const r2 = st.append('v2', ys2, 'demo-batch-2');
const f2 = Array.from({ length: 4 }, (_, i) => forecast(r2.model.cur, i + 1));
console.log('v2 未来4步预测:', f2);
console.log('差异:', f1.map((v, i) => +(f2[i] - v).toFixed(6)));
console.log('v1 快照数:', st.snapshots('v1').length, '（原版本保留可比较）');
console.log('注意：训练期残差是拟合误差，不等于真实未来预测精度。');
