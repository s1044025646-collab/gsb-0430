/** SQLite 持久层：模型、观测历史、批次幂等、快照。批次写入整体在一个事务中。 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  HwParams, HwState, StepResult, HwError,
  validateParams, validateInitialState, updateOne, forecast,
  MAX_BATCH, MAX_TOTAL_OBS,
} from "./model";

export interface ModelRow {
  id: number; name: string; m: number;
  alpha: number; beta: number; gamma: number;
  l: number; b: number; season: number[]; phase: number;
  init: HwState; version: number; parentId: number | null;
  obsCount: number; createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        m INTEGER NOT NULL,
        alpha REAL NOT NULL, beta REAL NOT NULL, gamma REAL NOT NULL,
        l REAL NOT NULL, b REAL NOT NULL, season TEXT NOT NULL, phase INTEGER NOT NULL,
        init_l REAL NOT NULL, init_b REAL NOT NULL, init_season TEXT NOT NULL, init_phase INTEGER NOT NULL,
        version INTEGER NOT NULL, parent_id INTEGER,
        obs_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL, seq INTEGER NOT NULL,
        y REAL NOT NULL, phase INTEGER NOT NULL, s_old REAL NOT NULL,
        one_step REAL NOT NULL, err REAL NOT NULL,
        l_new REAL NOT NULL, b_new REAL NOT NULL, s_new REAL NOT NULL,
        UNIQUE(model_id, seq)
      );
      CREATE TABLE IF NOT EXISTS batches (
        model_id INTEGER NOT NULL, key TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY (model_id, key)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL, label TEXT NOT NULL,
        state_json TEXT NOT NULL, forecast_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  private rowToModel(r: any): ModelRow {
    return {
      id: r.id, name: r.name, m: r.m,
      alpha: r.alpha, beta: r.beta, gamma: r.gamma,
      l: r.l, b: r.b, season: JSON.parse(r.season), phase: r.phase,
      init: { l: r.init_l, b: r.init_b, season: JSON.parse(r.init_season), phase: r.init_phase },
      version: r.version, parentId: r.parent_id,
      obsCount: r.obs_count, createdAt: r.created_at,
    };
  }

  getModel(id: number): ModelRow {
    const r = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id) as any;
    if (!r) throw new HwError("MODEL_NOT_FOUND", `模型 ${id} 不存在`);
    return this.rowToModel(r);
  }

  listModels(): ModelRow[] {
    return (this.db.prepare("SELECT * FROM models ORDER BY id").all() as any[]).map((r) => this.rowToModel(r));
  }

  createModel(input: {
    name?: string; m: number; alpha: number; beta: number; gamma: number;
    l: number; b: number; season: number[]; phase: number;
    parentId?: number | null;
  }): ModelRow {
    const p: HwParams = { m: input.m, alpha: input.alpha, beta: input.beta, gamma: input.gamma };
    validateParams(p);
    const st: HwState = { l: input.l, b: input.b, season: input.season, phase: input.phase };
    validateInitialState(st, input.m);
    let version = 1;
    if (input.parentId != null) {
      const parent = this.getModel(input.parentId);
      version = parent.version + 1;
    }
    const info = this.db.prepare(`
      INSERT INTO models (name, m, alpha, beta, gamma, l, b, season, phase,
        init_l, init_b, init_season, init_phase, version, parent_id, obs_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      input.name ?? `model-${Date.now()}`, p.m, p.alpha, p.beta, p.gamma,
      st.l, st.b, JSON.stringify(st.season), st.phase,
      st.l, st.b, JSON.stringify(st.season), st.phase,
      version, input.parentId ?? null, new Date().toISOString(),
    );
    return this.getModel(Number(info.lastInsertRowid));
  }

  /** 从已有模型派生独立试验版本：复制初始状态，可选覆盖平滑参数，不重放旧观测。 */
  forkModel(parentId: number, overrides: { name?: string; alpha?: number; beta?: number; gamma?: number }): ModelRow {
    const parent = this.getModel(parentId);
    return this.createModel({
      name: overrides.name ?? `${parent.name}-v${parent.version + 1}`,
      m: parent.m,
      alpha: overrides.alpha ?? parent.alpha,
      beta: overrides.beta ?? parent.beta,
      gamma: overrides.gamma ?? parent.gamma,
      l: parent.init.l, b: parent.init.b, season: parent.init.season, phase: parent.init.phase,
      parentId,
    });
  }

  /** 原子追加一批观测；idempotencyKey 命中时直接返回旧结果，不重复消费。 */
  appendBatch(modelId: number, values: number[], idempotencyKey?: string): { model: ModelRow; steps: StepResult[]; idempotentReplay: boolean } {
    if (!Array.isArray(values) || values.length === 0) throw new HwError("EMPTY_BATCH", "观测批次不能为空");
    if (values.length > MAX_BATCH) throw new HwError("BATCH_TOO_LARGE", `单批观测上限 ${MAX_BATCH}`);

    if (idempotencyKey) {
      const hit = this.db.prepare("SELECT result FROM batches WHERE model_id = ? AND key = ?").get(modelId, idempotencyKey) as any;
      if (hit) {
        const parsed = JSON.parse(hit.result);
        return { model: this.getModel(modelId), steps: parsed.steps, idempotentReplay: true };
      }
    }

    this.db.exec("BEGIN");
    try {
      const model = this.getModel(modelId);
      if (model.obsCount + values.length > MAX_TOTAL_OBS) {
        throw new HwError("TOO_MANY_OBS", `累计观测上限 ${MAX_TOTAL_OBS}`);
      }
      const p: HwParams = { m: model.m, alpha: model.alpha, beta: model.beta, gamma: model.gamma };
      let st: HwState = { l: model.l, b: model.b, season: model.season.slice(), phase: model.phase };
      const steps: StepResult[] = [];
      const insStep = this.db.prepare(`
        INSERT INTO steps (model_id, seq, y, phase, s_old, one_step, err, l_new, b_new, s_new)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < values.length; i++) {
        const r = updateOne(st, p, values[i], model.obsCount + i);
        st = r.state;
        steps.push(r.step);
        insStep.run(modelId, r.step.seq, r.step.y, r.step.phase, r.step.sOld,
          r.step.oneStep, r.step.err, r.step.lNew, r.step.bNew, r.step.sNew);
      }
      this.db.prepare("UPDATE models SET l=?, b=?, season=?, phase=?, obs_count=? WHERE id=?")
        .run(st.l, st.b, JSON.stringify(st.season), st.phase, model.obsCount + values.length, modelId);
      if (idempotencyKey) {
        this.db.prepare("INSERT INTO batches (model_id, key, result) VALUES (?, ?, ?)")
          .run(modelId, idempotencyKey, JSON.stringify({ steps }));
      }
      this.db.exec("COMMIT");
      return { model: this.getModel(modelId), steps, idempotentReplay: false };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getSteps(modelId: number, from = 0, to?: number): any[] {
    this.getModel(modelId);
    const end = to ?? Number.MAX_SAFE_INTEGER;
    return this.db.prepare(
      "SELECT seq, y, phase, s_old AS sOld, one_step AS oneStep, err, l_new AS lNew, b_new AS bNew, s_new AS sNew FROM steps WHERE model_id=? AND seq>=? AND seq<=? ORDER BY seq"
    ).all(modelId, from, end) as any[];
  }

  forecast(modelId: number, horizon: number): number[] {
    const m = this.getModel(modelId);
    return forecast({ l: m.l, b: m.b, season: m.season, phase: m.phase },
      { m: m.m, alpha: m.alpha, beta: m.beta, gamma: m.gamma }, horizon);
  }

  saveSnapshot(modelId: number, label: string, horizon: number): any {
    const m = this.getModel(modelId);
    const fc = this.forecast(modelId, horizon);
    const state = { l: m.l, b: m.b, season: m.season, phase: m.phase, obsCount: m.obsCount,
      params: { m: m.m, alpha: m.alpha, beta: m.beta, gamma: m.gamma }, version: m.version };
    const info = this.db.prepare("INSERT INTO snapshots (model_id, label, state_json, forecast_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(modelId, label, JSON.stringify(state), JSON.stringify(fc), new Date().toISOString());
    return { id: Number(info.lastInsertRowid), modelId, label, state, forecast: fc };
  }

  listSnapshots(modelId: number): any[] {
    this.getModel(modelId);
    return (this.db.prepare("SELECT * FROM snapshots WHERE model_id=? ORDER BY id").all(modelId) as any[])
      .map((r) => ({ id: r.id, modelId: r.model_id, label: r.label, state: JSON.parse(r.state_json), forecast: JSON.parse(r.forecast_json), createdAt: r.created_at }));
  }

  exportModel(modelId: number): any {
    const m = this.getModel(modelId);
    return { model: m, steps: this.getSteps(modelId), snapshots: this.listSnapshots(modelId) };
  }
}
