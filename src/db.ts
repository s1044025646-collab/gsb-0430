/** SQLite 持久化：模型、观测、更新历史、快照。批次提交原子化，requestId 幂等。 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HwParams, HwState, StepResult, HwError, MAX_BATCH, MAX_HISTORY, validateParams, validateState, step } from './hw';

export interface ModelRow {
  id: string; name: string; parentId: string | null;
  params: HwParams; init: HwState; cur: HwState; nObs: number; createdAt: string;
}

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS models(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
        params TEXT NOT NULL, init_state TEXT NOT NULL, cur_state TEXT NOT NULL,
        n_obs INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(
        model_id TEXT NOT NULL, idx INTEGER NOT NULL, y REAL NOT NULL,
        PRIMARY KEY(model_id, idx));
      CREATE TABLE IF NOT EXISTS history(
        model_id TEXT NOT NULL, idx INTEGER NOT NULL, rec TEXT NOT NULL,
        PRIMARY KEY(model_id, idx));
      CREATE TABLE IF NOT EXISTS requests(
        request_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(
        id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT NOT NULL,
        label TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }

  createModel(id: string, name: string, params: HwParams, init: HwState, parentId: string | null = null): ModelRow {
    validateParams(params); validateState(init);
    if (this.getModel(id)) throw new HwError('MODEL_EXISTS', `模型 ${id} 已存在`);
    this.db.prepare(`INSERT INTO models(id,name,parent_id,params,init_state,cur_state,n_obs,created_at)
      VALUES(?,?,?,?,?,?,0,?)`)
      .run(id, name, parentId, JSON.stringify(params), JSON.stringify(init), JSON.stringify(init), new Date().toISOString());
    return this.getModel(id)!;
  }

  getModel(id: string): ModelRow | null {
    const r = this.db.prepare('SELECT * FROM models WHERE id=?').get(id) as any;
    if (!r) return null;
    return { id: r.id, name: r.name, parentId: r.parent_id, params: JSON.parse(r.params),
      init: JSON.parse(r.init_state), cur: JSON.parse(r.cur_state), nObs: r.n_obs, createdAt: r.created_at };
  }

  listModels(): ModelRow[] {
    return (this.db.prepare('SELECT id FROM models ORDER BY created_at').all() as any[])
      .map(r => this.getModel(r.id)!);
  }

  history(id: string): StepResult[] {
    return (this.db.prepare('SELECT rec FROM history WHERE model_id=? ORDER BY idx').all(id) as any[])
      .map(r => JSON.parse(r.rec));
  }

  observations(id: string): number[] {
    return (this.db.prepare('SELECT y FROM observations WHERE model_id=? ORDER BY idx').all(id) as any[])
      .map(r => r.y);
  }

  /** 原子追加一批观测；requestId 幂等（重复请求直接返回首次结果）。 */
  append(id: string, ys: number[], requestId?: string): { model: ModelRow; recs: StepResult[]; duplicate: boolean } {
    if (!Array.isArray(ys) || ys.length === 0) throw new HwError('EMPTY_BATCH', '观测批次为空');
    if (ys.length > MAX_BATCH) throw new HwError('BATCH_TOO_LARGE', `单批观测上限 ${MAX_BATCH}`);
    if (requestId) {
      const hit = this.db.prepare('SELECT result FROM requests WHERE request_id=?').get(requestId) as any;
      if (hit) return { ...JSON.parse(hit.result), duplicate: true };
    }
    const m = this.getModel(id);
    if (!m) throw new HwError('NO_MODEL', `模型 ${id} 不存在`);
    if (m.nObs + ys.length > MAX_HISTORY) throw new HwError('HISTORY_FULL', `累计记录上限 ${MAX_HISTORY}`);
    ys.forEach((y, i) => { if (!Number.isFinite(y)) throw new HwError('NON_FINITE', `第 ${i} 条观测非有限数`); });

    const recs: StepResult[] = [];
    let st = m.cur;
    ys.forEach((y, i) => { const r = step(st, m.params, y, m.nObs + i); st = r.state; recs.push(r.rec); });

    const result = { model: { ...m, cur: st, nObs: m.nObs + ys.length }, recs, duplicate: false };
    this.db.exec('BEGIN');
    try {
      const insObs = this.db.prepare('INSERT INTO observations(model_id,idx,y) VALUES(?,?,?)');
      const insHis = this.db.prepare('INSERT INTO history(model_id,idx,rec) VALUES(?,?,?)');
      recs.forEach((rec, i) => { insObs.run(id, rec.index, ys[i]); insHis.run(id, rec.index, JSON.stringify(rec)); });
      this.db.prepare('UPDATE models SET cur_state=?, n_obs=? WHERE id=?')
        .run(JSON.stringify(st), m.nObs + ys.length, id);
      if (requestId) this.db.prepare('INSERT INTO requests(request_id,model_id,result) VALUES(?,?,?)')
        .run(requestId, id, JSON.stringify(result));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return result;
  }

  snapshot(id: string, label: string, payload: unknown): number {
    if (!this.getModel(id)) throw new HwError('NO_MODEL', `模型 ${id} 不存在`);
    const r = this.db.prepare('INSERT INTO snapshots(model_id,label,payload,created_at) VALUES(?,?,?,?)')
      .run(id, label, JSON.stringify(payload), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  snapshots(id: string): any[] {
    return this.db.prepare('SELECT * FROM snapshots WHERE model_id=? ORDER BY id').all(id) as any[];
  }

  close(): void { this.db.close(); }
}
