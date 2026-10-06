import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { step, forecast, HwError } from '../src/hw';
import { Store } from '../src/db';

const P = { alpha: 0.5, beta: 0.5, gamma: 0.5 };

test('已知样例: m=2 l=10 b=0 s=[2,-2] phase=0, 输入12,8 状态不变, 预测12,8,12', () => {
  let st = { l: 10, b: 0, s: [2, -2], phase: 0 };
  st = step(st, P, 12, 0).state;
  st = step(st, P, 8, 1).state;
  assert.deepEqual(st, { l: 10, b: 0, s: [2, -2], phase: 0 });
  assert.deepEqual([1, 2, 3].map(h => forecast(st, h)), [12, 8, 12]);
});

test('手算带趋势例: m=2 l=10 b=1 s=[1,-1] phase=0, y=12', () => {
  // lNew=.5*(12-1)+.5*11=11; bNew=.5*(11-10)+.5*1=1; sNew=.5*(12-11)+.5*1=1
  const { state, rec } = step({ l: 10, b: 1, s: [1, -1], phase: 0 }, P, 12, 0);
  assert.equal(rec.lNew, 11); assert.equal(rec.bNew, 1); assert.equal(rec.sNew, 1);
  assert.equal(rec.oneStepForecast, 12); assert.equal(rec.residual, 0);
  assert.equal(state.phase, 1);
});

test('非零相位起步: phase=1 用 s[1]，三步相位循环', () => {
  let st = { l: 5, b: 0, s: [10, 20, 30], phase: 1 };
  const r1 = step(st, P, 25, 0); // 用 s[1]=20
  assert.equal(r1.rec.phase, 1); assert.equal(r1.rec.sOld, 20);
  st = r1.state; assert.equal(st.phase, 2);
  st = step(st, P, 30, 1).state; assert.equal(st.phase, 0);
  st = step(st, P, 10, 2).state; assert.equal(st.phase, 1);
});

test('alpha=beta=gamma=0 状态完全不变; =1 完全用新信息', () => {
  const st0 = { l: 3, b: 1, s: [4, -4], phase: 0 };
  const s1 = step(st0, { alpha: 0, beta: 0, gamma: 0 }, 99, 0).state;
  assert.deepEqual(s1, { l: 4, b: 1, s: [4, -4], phase: 1 }); // l -> l+b 因 (1-0)*(l+b)
  const s2 = step(st0, { alpha: 1, beta: 1, gamma: 1 }, 99, 0).state;
  assert.equal(s2.l, 95); assert.equal(s2.b, 92); assert.equal(s2.s[0], 4);
});

test('常量序列 + 跨多周期预测循环', () => {
  let st = { l: 5, b: 0, s: [1, 2, 3], phase: 0 };
  for (let i = 0; i < 9; i++) st = step(st, P, 5 + st.s[st.phase], i).state;
  const vals = [1, 2, 3, 4, 5, 6, 7].map(h => forecast(st, h));
  assert.deepEqual(vals.map(v => v - st.l), [1, 2, 3, 1, 2, 3, 1]);
});

function tmpDb() { const f = `data/test-${Math.random().toString(36).slice(2)}.db`; return f; }

test('分批与一次提交等价; 重启(重开DB)后相位恢复', () => {
  const f1 = tmpDb(), f2 = tmpDb();
  const ys = [12, 8, 13, 7, 14, 6, 15];
  const a = new Store(f1);
  a.createModel('m', 'm', P, { l: 10, b: 0, s: [2, -2], phase: 0 });
  a.append('m', ys);
  const b = new Store(f2);
  b.createModel('m', 'm', P, { l: 10, b: 0, s: [2, -2], phase: 0 });
  b.append('m', ys.slice(0, 3));
  const b2 = new Store(f2); // 模拟重启
  b2.append('m', ys.slice(3));
  assert.deepEqual(b2.getModel('m')!.cur, a.getModel('m')!.cur);
  assert.deepEqual(b2.history('m'), a.history('m'));
  a.close(); b.close(); b2.close(); fs.rmSync(f1,{force:true}); fs.rmSync(f2,{force:true});
});

test('预测只读不写状态', () => {
  const f = tmpDb(); const s = new Store(f);
  s.createModel('m', 'm', P, { l: 10, b: 0, s: [2, -2], phase: 0 });
  const before = s.getModel('m')!.cur;
  forecast(before, 5);
  assert.deepEqual(s.getModel('m')!.cur, before);
  s.close(); fs.rmSync(f,{force:true});
});

test('非法相位/参数/非有限值 -> 失败且回滚', () => {
  const f = tmpDb(); const s = new Store(f);
  assert.throws(() => s.createModel('x', 'x', P, { l: 1, b: 0, s: [1, -1], phase: 2 }), HwError);
  assert.throws(() => s.createModel('x', 'x', { alpha: 1.5, beta: 0, gamma: 0 }, { l: 1, b: 0, s: [1, -1], phase: 0 }), HwError);
  assert.throws(() => s.createModel('x', 'x', P, { l: 1, b: 0, s: [1], phase: 0 }), HwError);
  s.createModel('m', 'm', P, { l: 1, b: 0, s: [-1e308, 1], phase: 0 });
  assert.throws(() => s.append('m', [1, Infinity]), HwError);
  assert.throws(() => s.append('m', [1e308]), HwError);
  const m = s.getModel('m')!;
  assert.equal(m.nObs, 0); // 无部分更新
  assert.deepEqual(m.cur, m.init);
  s.close(); fs.rmSync(f,{force:true});
});

test('requestId 幂等: 重复请求不重复消费观测', () => {
  const f = tmpDb(); const s = new Store(f);
  s.createModel('m', 'm', P, { l: 10, b: 0, s: [2, -2], phase: 0 });
  const r1 = s.append('m', [12, 8], 'req-1');
  const r2 = s.append('m', [12, 8], 'req-1');
  assert.equal(r2.duplicate, true);
  assert.equal(s.getModel('m')!.nObs, 2);
  assert.deepEqual(r1.recs, r2.recs);
  s.close(); fs.rmSync(f,{force:true});
});

test('负观测/负趋势/负预测不截断', () => {
  let st = { l: -10, b: -2, s: [1, -1], phase: 0 };
  st = step(st, P, -15, 0).state;
  assert.ok(forecast(st, 1) < 0);
});


