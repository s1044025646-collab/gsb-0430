/** 加法 Holt-Winters 核心：纯函数，无 IO。 */

export interface HwParams { alpha: number; beta: number; gamma: number; }
export interface HwState { l: number; b: number; s: number[]; phase: number; }
export interface StepResult {
  index: number;          // 观测在序列中的序号（从 0 开始）
  y: number;
  phase: number;          // 本次观测使用的旧季节槽位
  sOld: number;
  oneStepForecast: number; // 处理前的一步预测 l + b + sOld
  residual: number;        // y - oneStepForecast（训练期误差，非未来精度）
  lOld: number; bOld: number;
  lNew: number; bNew: number; sNew: number;
}

export const MIN_M = 2, MAX_M = 24;
export const MAX_BATCH = 10000;   // 单批观测上限
export const MAX_HORIZON = 1000;  // 预测步数上限
export const MAX_HISTORY = 1000000; // 累计更新记录上限

export class HwError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function finite(x: number, what: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new HwError('NON_FINITE', `${what} 必须为有限数，得到 ${x}`);
  return x;
}

export function validateParams(p: HwParams): void {
  for (const k of ['alpha', 'beta', 'gamma'] as const) {
    finite(p[k], k);
    if (p[k] < 0 || p[k] > 1) throw new HwError('PARAM_RANGE', `${k} 必须在 [0,1]，得到 ${p[k]}`);
  }
}

export function validateState(st: HwState): void {
  finite(st.l, 'l'); finite(st.b, 'b');
  if (!Array.isArray(st.s) || st.s.length < MIN_M || st.s.length > MAX_M)
    throw new HwError('BAD_M', `季节数组长度 m 必须在 ${MIN_M}..${MAX_M}`);
  st.s.forEach((v, i) => finite(v, `s[${i}]`));
  if (!Number.isInteger(st.phase) || st.phase < 0 || st.phase >= st.s.length)
    throw new HwError('BAD_PHASE', `相位必须是 [0, m) 的整数，得到 ${st.phase}`);
}

/** 单步加法 Holt-Winters 更新。返回新状态与过程量，不修改入参。 */
export function step(st: HwState, p: HwParams, y: number, index: number): { state: HwState; rec: StepResult } {
  finite(y, '观测 y');
  const l = st.l, b = st.b, phase = st.phase, sOld = st.s[phase];
  const lNew = p.alpha * (y - sOld) + (1 - p.alpha) * (l + b);
  const bNew = p.beta * (lNew - l) + (1 - p.beta) * b;
  const sNew = p.gamma * (y - lNew) + (1 - p.gamma) * sOld;
  finite(lNew, 'lNew'); finite(bNew, 'bNew'); finite(sNew, 'sNew');
  const s = st.s.slice(); s[phase] = sNew;
  return {
    state: { l: lNew, b: bNew, s, phase: (phase + 1) % s.length },
    rec: {
      index, y, phase, sOld,
      oneStepForecast: l + b + sOld,
      residual: y - (l + b + sOld),
      lOld: l, bOld: b, lNew, bNew, sNew,
    },
  };
}

/** 未来第 h 步（h>=1）：l + h*b + 从下一相位起循环取第 h 个季节项。只读。 */
export function forecast(st: HwState, h: number): number {
  if (!Number.isInteger(h) || h < 1 || h > MAX_HORIZON) throw new HwError('BAD_HORIZON', `h 必须是 1..${MAX_HORIZON} 的整数`);
  const m = st.s.length;
  const v = st.l + h * st.b + st.s[(st.phase + h - 1) % m];
  return finite(v, '预测值');
}
