/** CLI：node dist/cli.js <command> ... */
import { Store } from './db';
import { forecast } from './hw';
import { startApi } from './api';
import * as path from 'node:path';

const DB = process.env.HW_DB ?? path.join('data', 'hw.db');
const args = process.argv.slice(2);
const cmd = args[0];
const j = (s: string) => JSON.parse(s);

function store() { return new Store(DB); }
function out(x: unknown) { console.log(JSON.stringify(x, null, 2)); }

function main() {
  switch (cmd) {
    case 'serve': {
      const port = Number(args[1] ?? process.env.PORT ?? 0);
      startApi(DB, port); break;
    }
    case 'create': {
      // create <id> <l> <b> <sJson> <phase> <alpha> <beta> <gamma> [name] [parentId]
      const [id, l, b, s, phase, alpha, beta, gamma, name, parentId] = args.slice(1);
      out(store().createModel(id, name ?? id,
        { alpha: +alpha, beta: +beta, gamma: +gamma },
        { l: +l, b: +b, s: j(s), phase: +phase }, parentId ?? null));
      break;
    }
    case 'append': { // append <id> <yJsonArray> [requestId]
      out(store().append(args[1], j(args[2]), args[3])); break;
    }
    case 'state': out(store().getModel(args[1])); break;
    case 'list': out(store().listModels()); break;
    case 'history': out(store().history(args[1])); break;
    case 'forecast': { // forecast <id> <h>
      const m = store().getModel(args[1]);
      if (!m) throw new Error('模型不存在');
      const h = Number(args[2] ?? 1);
      out({ h, values: Array.from({ length: h }, (_, i) => forecast(m.cur, i + 1)) });
      break;
    }
    case 'snapshot': { // snapshot <id> [label]
      const st = store(); const m = st.getModel(args[1]);
      if (!m) throw new Error('模型不存在');
      out({ snapshotId: st.snapshot(args[1], args[2] ?? '', { model: m, history: st.history(args[1]) }) });
      break;
    }
    case 'export': { // export <id>
      const st = store();
      out({ model: st.getModel(args[1]), observations: st.observations(args[1]), history: st.history(args[1]) });
      break;
    }
    default:
      console.log(`用法: node dist/cli.js <command>
  serve [port]                 启动 API（默认自动选空闲端口）
  create <id> <l> <b> <sJson> <phase> <alpha> <beta> <gamma> [name] [parentId]
  append <id> <yJsonArray> [requestId]
  state|list|history <id>
  forecast <id> <h>
  snapshot <id> [label]
  export <id>`);
  }
}
main();
