/** 加法 Holt-Winters 核心：状态、校验、单步更新与预测。纯函数，无副作用。 */

export const MIN_PERIOD = 2;
export const MAX_PERIOD = 24;
export const MAX_BATCH = 10000;      // 单批观测上限
export const MAX_HORIZON = 1000;     // 单次预测步数上限
export const MAX_TOTAL_OBS = 1_000_000; // 单模型累计观测上限

export interface HwState {
  l: number;          // 当前水平
  b: number;          // 当前趋势
  season: number[];   // 长度 m 的季节槽位
  phase: number;      // 下一条观测将使用的槽位下标
}

export interface HwParams {
  m: number;
  alpha: number;
  beta: number;
  gamma: number;
}

export class HwError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "HwError";
  }
}

export function assertFinite(x: number, what: string): void {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new HwError("NON_FINITE", `${what} 必须是有限数值，收到: ${String(x)}`);
  }
}

export function validateParams(p: HwParams): void {
  if (!Number.isInteger(p.m) || p.m < MIN_PERIOD || p.m > MAX_PERIOD) {
    throw new HwError("INVALID_PERIOD", `周期 m 必须是 ${MIN_PERIOD}..${MAX_PERIOD} 的整数，收到: ${p.m}`);
  }
  for (const [name, v] of [["alpha", p.alpha], ["beta", p.beta], ["gamma", p.gamma]] as const) {
    assertFinite(v, name);
    if (v < 0 || v > 1) throw new HwError("INVALID_SMOOTHING", `${name} 必须在 [0,1] 内，收到: ${v}`);
  }
}

export function validateInitialState(st: HwState, m: number): void {
  assertFinite(st.l, "初始水平 l");
  assertFinite(st.b, "初始趋势 b");
  if (!Array.isArray(st.season) || st.season.length !== m) {
    throw new HwError("INVALID_SEASON", `季节数组长度必须等于 m=${m}`);
  }
  st.season.forEach((s, i) => assertFinite(s, `season[${i}]`));
  if (!Number.isInteger(st.phase) || st.phase < 0 || st.phase >= m) {
    throw new HwError("INVALID_PHASE", `相位必须是 [0, ${m}) 的整数，收到: ${st.phase}`);
  }
}

export interface StepResult {
  seq: number;        // 本批内序号（从 0 开始）
  y: number;          // 真实观测
  phase: number;      // 本步使用的旧槽位
  sOld: number;       // 旧季节槽值
  oneStep: number;    // 更新前的一步预测 l + b + sOld
  err: number;        // y - oneStep（训练期一步误差，非未来精度）
  lNew: number;
  bNew: number;
  sNew: number;
}

/** 单步加法 Holt-Winters 更新。不修改入参，返回新状态。 */
export function updateOne(st: HwState, p: HwParams, y: number, seq: number): { state: HwState; step: StepResult } {
  assertFinite(y, `观测 y[${seq}]`);
  const sOld = st.season[st.phase];
  const oneStep = st.l + st.b + sOld;
  const lNew = p.alpha * (y - sOld) + (1 - p.alpha) * (st.l + st.b);
  const bNew = p.beta * (lNew - st.l) + (1 - p.beta) * st.b;
  const sNew = p.gamma * (y - lNew) + (1 - p.gamma) * sOld;
  assertFinite(lNew, "lNew"); assertFinite(bNew, "bNew"); assertFinite(sNew, "sNew");
  assertFinite(oneStep, "oneStep");
  const season = st.season.slice();
  season[st.phase] = sNew;
  const state: HwState = { l: lNew, b: bNew, season, phase: (st.phase + 1) % p.m };
  return { state, step: { seq, y, phase: st.phase, sOld, oneStep, err: y - oneStep, lNew, bNew, sNew } };
}

/** 未来第 h 步（h 从 1 开始）预测：l + h*b + 从下一相位循环取第 h 个季节项。只读。 */
export function forecastOne(st: HwState, p: HwParams, h: number): number {
  const s = st.season[(st.phase + (h - 1)) % p.m];
  const f = st.l + h * st.b + s;
  assertFinite(f, `forecast(${h})`);
  return f;
}

export function forecast(st: HwState, p: HwParams, horizon: number): number[] {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON) {
    throw new HwError("INVALID_HORIZON", `预测步数必须是 1..${MAX_HORIZON} 的整数，收到: ${horizon}`);
  }
  const out: number[] = [];
  for (let h = 1; h <= horizon; h++) out.push(forecastOne(st, p, h));
  return out;
}
