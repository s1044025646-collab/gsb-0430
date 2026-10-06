/** CLI：直接操作本地 SQLite，与 API 共享同一套核心逻辑。 */
import * as path from "node:path";
import { Store } from "./db";

const DB_PATH = process.env.HW_DB ?? path.join(__dirname, "..", "data", "hw.db");

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function num(args: string[], name: string, dflt?: number): number {
  const v = argValue(args, name);
  if (v === undefined) {
    if (dflt !== undefined) return dflt;
    throw new Error(`缺少参数 --${name}`);
  }
  return Number(v);
}

const USAGE = `用法: node dist/cli.js <命令> [选项]
  create --m 2 --l 10 --b 0 --season 2,-2 --phase 0 --alpha .5 --beta .5 --gamma .5 [--name x]
  append --model 1 --values 12,8 [--key batch-1]
  state --model 1
  steps --model 1 [--from 0] [--to 9]
  forecast --model 1 --h 3
  fork --model 1 [--alpha 0.3] [--name x]
  snapshot --model 1 --label tag [--h 12]
  snapshots --model 1
  export --model 1
  list
数据库: 环境变量 HW_DB，默认 data/hw.db`;

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "create":
        console.log(JSON.stringify(store.createModel({
          name: argValue(args, "name"),
          m: num(args, "m"), l: num(args, "l"), b: num(args, "b"),
          season: String(argValue(args, "season") ?? "").split(",").map(Number),
          phase: num(args, "phase"),
          alpha: num(args, "alpha"), beta: num(args, "beta"), gamma: num(args, "gamma"),
        }), null, 2));
        break;
      case "append": {
        const values = String(argValue(args, "values") ?? "").split(",").filter(Boolean).map(Number);
        console.log(JSON.stringify(store.appendBatch(num(args, "model"), values, argValue(args, "key")), null, 2));
        break;
      }
      case "state": console.log(JSON.stringify(store.getModel(num(args, "model")), null, 2)); break;
      case "steps": {
        const from = argValue(args, "from"); const to = argValue(args, "to");
        console.log(JSON.stringify(store.getSteps(num(args, "model"), from ? Number(from) : 0, to ? Number(to) : undefined), null, 2));
        break;
      }
      case "forecast": console.log(JSON.stringify({ forecast: store.forecast(num(args, "model"), num(args, "h")) }, null, 2)); break;
      case "fork":
        console.log(JSON.stringify(store.forkModel(num(args, "model"), {
          name: argValue(args, "name"),
          alpha: argValue(args, "alpha") !== undefined ? Number(argValue(args, "alpha")) : undefined,
          beta: argValue(args, "beta") !== undefined ? Number(argValue(args, "beta")) : undefined,
          gamma: argValue(args, "gamma") !== undefined ? Number(argValue(args, "gamma")) : undefined,
        }), null, 2));
        break;
      case "snapshot": console.log(JSON.stringify(store.saveSnapshot(num(args, "model"), argValue(args, "label") ?? "snapshot", num(args, "h", 12)), null, 2)); break;
      case "snapshots": console.log(JSON.stringify(store.listSnapshots(num(args, "model")), null, 2)); break;
      case "export": console.log(JSON.stringify(store.exportModel(num(args, "model")), null, 2)); break;
      case "list": console.log(JSON.stringify(store.listModels(), null, 2)); break;
      default: console.log(USAGE);
    }
  } finally {
    store.close();
  }
}

try { main(); } catch (e: any) {
  console.error(`错误 [${e.code ?? "ERR"}]: ${e.message}`);
  process.exit(1);
}
