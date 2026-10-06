import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../src/db";
import { updateOne, forecast, HwError, HwParams, HwState } from "../src/model";

const TMP = path.join(__dirname, "..", "..", "data", "test");
fs.mkdirSync(TMP, { recursive: true });
function freshStore(name: string): { store: Store; file: string } {
  const file = path.join(TMP, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return { store: new Store(file), file };
}

/** 独立手算参考实现（与 src/model.ts 分开写，用于交叉核验）。 */
function refStep(st: HwState, p: HwParams, y: number): HwState {
  const s = st.season[st.phase];
  const l = p.alpha * (y - s) + (1 - p.alpha) * (st.l + st.b);
  const b = p.beta * (l - st.l) + (1 - p.beta) * st.b;
  const sNew = p.gamma * (y - l) + (1 - p.gamma) * s;
  const season = st.season.slice();
  season[st.phase] = sNew;
  return { l, b, season, phase: (st.phase + 1) % p.m };
}
function refRun(init: HwState, p: HwParams, ys: number[]): HwState {
  let st = { ...init, season: init.season.slice() };
  for (const y of ys) st = refStep(st, p, y);
  return st;
}
function refForecast(st: HwState, m: number, h: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= h; i++) out.push(st.l + i * st.b + st.season[(st.phase + i - 1) % m]);
  return out;
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("已知样例：m=2 状态不变，预测 12,8,12", () => {
  const { store } = freshStore("sample");
  const m = store.createModel({ m: 2, l: 10, b: 0, season: [2, -2], phase: 0, alpha: 0.5, beta: 0.5, gamma: 0.5 });
  const r = store.appendBatch(m.id, [12, 8]);
  close(r.model.l, 10); close(r.model.b, 0);
  assert.deepEqual(r.model.season, [2, -2]);
  assert.equal(r.model.phase, 0);
  assert.deepEqual(store.forecast(m.id, 3), [12, 8, 12]);
  // 一步预测与误差
  assert.equal(r.steps[0].oneStep, 12); assert.equal(r.steps[0].err, 0);
  assert.equal(r.steps[1].oneStep, 8); assert.equal(r.steps[1].err, 0);
  store.close();
});

test("带趋势 + 相位非零：逐步对照独立参考实现", () => {
  const p: HwParams = { m: 4, alpha: 0.4, beta: 0.2, gamma: 0.6 };
  const init: HwState = { l: 100, b: 2, season: [5, -3, -4, 2], phase: 2 };
  const ys = [98, 105, 110];
  // 第一步手算字面值
  const s1 = updateOne(init, p, 98, 0);
  close(s1.state.l, 102); close(s1.state.b, 2); close(s1.state.season[2], -4);
  assert.equal(s1.step.phase, 2); assert.equal(s1.step.sOld, -4);
  let st = init;
  for (let i = 0; i < ys.length; i++) {
    const r = updateOne(st, p, ys[i], i);
    const ref = refStep(st, p, ys[i]);
    close(r.state.l, ref.l); close(r.state.b, ref.b);
    r.state.season.forEach((s, j) => close(s, ref.season[j]));
    assert.equal(r.state.phase, ref.phase);
    st = r.state;
  }
  // 1~3 步预测对照
  const fc = forecast(st, p, 3);
  const refFc = refForecast(st, p.m, 3);
  fc.forEach((f, i) => close(f, refFc[i]));
});

test("参数为 0：状态不更新", () => {
  const p: HwParams = { m: 2, alpha: 0, beta: 0, gamma: 0 };
  let st: HwState = { l: 5, b: 1, season: [3, -3], phase: 0 };
  for (const y of [100, -50, 7]) st = updateOne(st, p, y, 0).state;
  close(st.l, 8); // alpha=0 时 lNew = l + b，每步加趋势
  close(st.b, 1);
  assert.deepEqual(st.season, [3, -3]);
  assert.equal(st.phase, 1); // 相位仍前进
});

test("参数为 1：完全采用新信息", () => {
  const p: HwParams = { m: 2, alpha: 1, beta: 1, gamma: 1 };
  const r = updateOne({ l: 0, b: 0, season: [1, -1], phase: 0 }, p, 10, 0);
  close(r.state.l, 9);          // y - sOld
  close(r.state.b, 9);          // lNew - l
  close(r.state.season[0], 1);  // y - lNew
});

test("常量序列：水平收敛到常量，季节项收敛到 0", () => {
  const p: HwParams = { m: 4, alpha: 0.5, beta: 0.5, gamma: 0.5 };
  let st: HwState = { l: 0, b: 0, season: [0, 0, 0, 0], phase: 0 };
  for (let i = 0; i < 200; i++) st = updateOne(st, p, 7, i).state;
  close(st.l + st.b + st.season[st.phase], 7);
});

test("跨多周期预测循环正确", () => {
  const st: HwState = { l: 10, b: 1, season: [1, 2, 3], phase: 1 };
  const p: HwParams = { m: 3, alpha: 0, beta: 0, gamma: 0 };
  // h=1..7: season 下标 1,2,0,1,2,0,1
  assert.deepEqual(forecast(st, p, 7), [13, 15, 14, 16, 18, 17, 19]);
});

test("分批提交与一次提交一致", () => {
  const ys = Array.from({ length: 50 }, (_, i) => 10 + 0.3 * i + 4 * Math.sin((2 * Math.PI * i) / 6));
  const mk = (s: Store) => s.createModel({ m: 6, l: 10, b: 0.3, season: [0, 4, 0, -4, 0, 0], phase: 0, alpha: 0.3, beta: 0.1, gamma: 0.4 });
  const a = freshStore("batch-a"); const b = freshStore("batch-b");
  const ma = mk(a.store); const mb = mk(b.store);
  a.store.appendBatch(ma.id, ys);
  b.store.appendBatch(mb.id, ys.slice(0, 7));
  b.store.appendBatch(mb.id, ys.slice(7, 23));
  b.store.appendBatch(mb.id, ys.slice(23));
  const sa = a.store.getModel(ma.id); const sb = b.store.getModel(mb.id);
  close(sa.l, sb.l); close(sa.b, sb.b); assert.equal(sa.phase, sb.phase);
  sa.season.forEach((s, i) => close(s, sb.season[i]));
  a.store.close(); b.store.close();
});

test("重启后从数据库恢复相位继续", () => {
  const { store, file } = freshStore("restart");
  const m = store.createModel({ m: 3, l: 1, b: 0.5, season: [2, 0, -2], phase: 0, alpha: 0.5, beta: 0.5, gamma: 0.5 });
  store.appendBatch(m.id, [3.5, 1.2]);
  store.close();
  const store2 = new Store(file);
  const restored = store2.getModel(m.id);
  assert.equal(restored.phase, 2);
  store2.appendBatch(m.id, [-1.7]);
  const steps = store2.getSteps(m.id);
  assert.equal(steps.length, 3);
  assert.equal(steps[2].phase, 2);
  store2.close();
});

test("预测只读，不改变状态", () => {
  const { store } = freshStore("readonly");
  const m = store.createModel({ m: 2, l: 10, b: 1, season: [1, -1], phase: 0, alpha: 0.5, beta: 0.5, gamma: 0.5 });
  store.appendBatch(m.id, [12, 9]);
  const before = store.getModel(m.id);
  store.forecast(m.id, 100);
  const after = store.getModel(m.id);
  assert.deepEqual(after, before);
  store.close();
});

test("非法相位与非法参数被拒绝", () => {
  const { store } = freshStore("invalid");
  assert.throws(() => store.createModel({ m: 2, l: 1, b: 0, season: [1, -1], phase: 2, alpha: 0.5, beta: 0.5, gamma: 0.5 }), HwError);
  assert.throws(() => store.createModel({ m: 1, l: 1, b: 0, season: [1], phase: 0, alpha: 0.5, beta: 0.5, gamma: 0.5 }), HwError);
  assert.throws(() => store.createModel({ m: 25, l: 1, b: 0, season: Array(25).fill(0), phase: 0, alpha: 0.5, beta: 0.5, gamma: 0.5 }), HwError);
  assert.throws(() => store.createModel({ m: 2, l: 1, b: 0, season: [1, -1], phase: 0, alpha: 1.5, beta: 0.5, gamma: 0.5 }), HwError);
  assert.throws(() => store.createModel({ m: 2, l: 1, b: 0, season: [1], phase: 0, alpha: 0.5, beta: 0.5, gamma: 0.5 }), HwError);
  store.close();
});

test("超大值导致溢出：明确失败且批次回滚", () => {
  const { store } = freshStore("overflow");
  const m = store.createModel({ m: 2, l: 1e308, b: 1e308, season: [2, -2], phase: 0, alpha: 0.5, beta: 0.5, gamma: 0.5 });
  const before = store.getModel(m.id);
  assert.throws(() => store.appendBatch(m.id, [1e308, -1e308]), HwError); // l+b = 2e308 溢出为 Infinity
  const after = store.getModel(m.id);
  assert.deepEqual(after, before); // 无部分槽位更新
  assert.equal(store.getSteps(m.id).length, 0);
  assert.throws(() => store.appendBatch(m.id, [NaN]), HwError);
  assert.throws(() => store.appendBatch(m.id, [Infinity]), HwError);
  store.close();
});

test("幂等键：重复请求不重复消费观测", () => {
  const { store } = freshStore("idem");
  const m = store.createModel({ m: 2, l: 10, b: 0, season: [2, -2], phase: 0, alpha: 0.5, beta: 0.5, gamma: 0.5 });
  const r1 = store.appendBatch(m.id, [12, 8], "k1");
  const r2 = store.appendBatch(m.id, [12, 8], "k1");
  assert.equal(r2.idempotentReplay, true);
  assert.equal(store.getModel(m.id).obsCount, 2);
  assert.equal(store.getSteps(m.id).length, 2);
  store.close();
});

test("fork 创建独立版本，参数不串用", () => {
  const { store } = freshStore("fork");
  const m = store.createModel({ m: 2, l: 10, b: 0, season: [2, -2], phase: 0, alpha: 0.5, beta: 0.5, gamma: 0.5 });
  store.appendBatch(m.id, [12, 8]);
  const v = store.forkModel(m.id, { alpha: 0.1 });
  assert.equal(v.version, 2);
  assert.equal(v.parentId, m.id);
  assert.equal(v.alpha, 0.1);
  assert.equal(v.obsCount, 0); // 不重放旧观测
  store.appendBatch(v.id, [15, 3]);
  assert.notEqual(store.getModel(v.id).l, store.getModel(m.id).l);
  store.close();
});

test("负观测与负趋势允许，预测不截零", () => {
  const st: HwState = { l: -50, b: -10, season: [-5, 5], phase: 0 };
  const p: HwParams = { m: 2, alpha: 0.5, beta: 0.5, gamma: 0.5 };
  const r = updateOne(st, p, -60, 0);
  assert.ok(Number.isFinite(r.state.l));
  const fc = forecast(st, p, 3);
  assert.deepEqual(fc, [-65, -65, -85]);
});


