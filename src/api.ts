/** HTTP API（node:http，无外部依赖）。默认端口 0 = 自动选空闲端口。 */
import * as http from 'node:http';
import { Store } from './db';
import { forecast, HwError, HwParams, HwState } from './hw';

function send(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
}

async function body(req: http.IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

export function createServer(store: Store) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      const b = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await body(req);

      if (req.method === 'POST' && parts[0] === 'models' && parts.length === 1) {
        const m = store.createModel(b.id, b.name ?? b.id, b.params as HwParams,
          { l: b.l, b: b.b, s: b.s, phase: b.phase } as HwState, b.parentId ?? null);
        return send(res, 201, m);
      }
      if (req.method === 'GET' && parts[0] === 'models' && parts.length === 1)
        return send(res, 200, store.listModels());
      const id = parts[1];
      if (req.method === 'GET' && parts[0] === 'models' && parts.length === 2) {
        const m = store.getModel(id); if (!m) throw new HwError('NO_MODEL', '模型不存在');
        return send(res, 200, m);
      }
      if (req.method === 'POST' && parts[2] === 'observations')
        return send(res, 200, store.append(id, b.y, b.requestId));
      if (req.method === 'GET' && parts[2] === 'history')
        return send(res, 200, store.history(id));
      if (req.method === 'GET' && parts[2] === 'observations')
        return send(res, 200, store.observations(id));
      if (req.method === 'GET' && parts[2] === 'forecast') {
        const m = store.getModel(id); if (!m) throw new HwError('NO_MODEL', '模型不存在');
        const h = Number(b.h ?? 1);
        const hs = Array.from({ length: h }, (_, i) => i + 1);
        return send(res, 200, { h, values: hs.map(x => forecast(m.cur, x)),
          note: '训练期残差不等于真实未来预测精度；未提供置信区间。' });
      }
      if (req.method === 'POST' && parts[2] === 'snapshots') {
        const m = store.getModel(id); if (!m) throw new HwError('NO_MODEL', '模型不存在');
        const snapId = store.snapshot(id, b.label ?? '', { model: m, history: store.history(id) });
        return send(res, 201, { snapshotId: snapId });
      }
      if (req.method === 'GET' && parts[2] === 'snapshots')
        return send(res, 200, store.snapshots(id));
      if (req.method === 'GET' && parts[2] === 'export') {
        const m = store.getModel(id); if (!m) throw new HwError('NO_MODEL', '模型不存在');
        return send(res, 200, { model: m, observations: store.observations(id), history: store.history(id) });
      }
      send(res, 404, { error: 'NOT_FOUND', message: '未知路由' });
    } catch (e: any) {
      if (e instanceof HwError) send(res, 400, { error: e.code, message: e.message });
      else send(res, 500, { error: 'INTERNAL', message: String(e?.message ?? e) });
    }
  });
}

export function startApi(dbFile: string, port = 0): Promise<number> {
  const store = new Store(dbFile);
  const srv = createServer(store);
  return new Promise(resolve => srv.listen(port, () => {
    const p = (srv.address() as any).port;
    console.log(`API 已启动: http://127.0.0.1:${p}  (数据库: ${dbFile})`);
    resolve(p);
  }));
}
