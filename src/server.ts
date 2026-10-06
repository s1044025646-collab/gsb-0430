/** HTTP API 服务（node:http，零依赖）。默认端口 0 = 自动选择空闲端口。 */
import * as http from "node:http";
import * as path from "node:path";
import { Store } from "./db";
import { HwError, MAX_BATCH, MAX_HORIZON, MAX_TOTAL_OBS, MIN_PERIOD, MAX_PERIOD } from "./model";

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.HW_DB ?? path.join(DATA_DIR, "hw.db");

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HwError("BAD_JSON", "请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const body = req.method === "POST" ? await readBody(req) : {};

      if (req.method === "GET" && url.pathname === "/config") {
        return send(res, 200, { MIN_PERIOD, MAX_PERIOD, MAX_BATCH, MAX_HORIZON, MAX_TOTAL_OBS });
      }
      if (req.method === "GET" && url.pathname === "/models") {
        return send(res, 200, store.listModels());
      }
      if (req.method === "POST" && url.pathname === "/models") {
        return send(res, 201, store.createModel(body));
      }
      if (parts[0] === "models" && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new HwError("BAD_ID", "模型 id 必须是整数");
        const sub = parts[2];
        if (req.method === "GET" && parts.length === 2) return send(res, 200, store.getModel(id));
        if (req.method === "POST" && sub === "observations") {
          const r = store.appendBatch(id, body.values, body.idempotencyKey);
          return send(res, r.idempotentReplay ? 200 : 201, r);
        }
        if (req.method === "GET" && sub === "steps") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          return send(res, 200, store.getSteps(id, from ? Number(from) : 0, to ? Number(to) : undefined));
        }
        if (req.method === "POST" && sub === "forecast") {
          return send(res, 200, { modelId: id, forecast: store.forecast(id, Number(body.h)) });
        }
        if (req.method === "POST" && sub === "fork") {
          return send(res, 201, store.forkModel(id, body));
        }
        if (req.method === "POST" && sub === "snapshots") {
          return send(res, 201, store.saveSnapshot(id, body.label ?? "snapshot", Number(body.h ?? 12)));
        }
        if (req.method === "GET" && sub === "snapshots") return send(res, 200, store.listSnapshots(id));
        if (req.method === "GET" && sub === "export") return send(res, 200, store.exportModel(id));
      }
      throw new HwError("NOT_FOUND", `未知路由: ${req.method} ${url.pathname}`);
    } catch (e: any) {
      if (e instanceof HwError) return send(res, 400, { error: e.code, message: e.message });
      send(res, 500, { error: "INTERNAL", message: String(e?.message ?? e) });
    }
  });
}

if (require.main === module) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 0);
  const store = new Store(DB_PATH);
  const server = createServer(store);
  server.listen(port, () => {
    const addr = server.address() as any;
    console.log(`Holt-Winters API 已启动: http://127.0.0.1:${addr.port}  (数据库: ${DB_PATH})`);
  });
}
