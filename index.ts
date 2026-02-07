import http from "node:http";
import { execFile } from "node:child_process";

type BridgeConfig = {
  enabled: boolean;
  port: number;
  path: string;
  token?: string;
};

const configSchema = {
  parse(value: unknown): BridgeConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
    const port = typeof raw.port === "number" ? raw.port : 8787;
    const path = typeof raw.path === "string" ? raw.path : "/agentlink/message";
    const token = typeof raw.token === "string" ? raw.token : undefined;
    return { enabled, port, path, token };
  },
  uiHints: {
    enabled: { label: "Enabled" },
    port: { label: "Listen Port" },
    path: { label: "Listen Path" },
    token: { label: "AgentLink Token", sensitive: true },
  },
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const header = req.headers["x-agentlink-token"];
  return typeof header === "string" ? header : undefined;
}

export default {
  id: "agentlink-bridge",
  name: "AgentLink Bridge",
  description: "Receive AgentLink messages and trigger OpenClaw agent runs.",
  configSchema,
  register(api: any) {
    const config = configSchema.parse(api.pluginConfig);
    let server: http.Server | null = null;

    const start = async () => {
      if (!config.enabled) {
        api.logger.info("[agentlink-bridge] disabled by config");
        return;
      }
      if (!config.token) {
        api.logger.warn("[agentlink-bridge] missing token; refusing to start");
        return;
      }
      server = http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== config.path) {
          res.writeHead(404);
          res.end();
          return;
        }
        const token = parseToken(req);
        if (!token || token !== config.token) {
          res.writeHead(401);
          res.end("unauthorized");
          return;
        }
        try {
          const raw = await readBody(req);
          const payload = raw ? JSON.parse(raw) : {};
          const message = typeof payload.message === "string" ? payload.message.trim() : "";
          const sessionId =
            typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
          const agent =
            typeof payload.agent === "string" ? payload.agent.trim() : "";
          if (!message) {
            res.writeHead(400);
            res.end("message required");
            return;
          }

          const args = ["agent", "--message", message, "--json"];
          if (sessionId) {
            args.push("--session-id", sessionId);
          } else if (agent) {
            args.push("--agent", agent);
          }

          execFile("openclaw", args, { timeout: 120000 }, (err, stdout, stderr) => {
            if (err) {
              api.logger.error(
                `[agentlink-bridge] openclaw agent failed: ${stderr || err.message}`,
              );
              res.writeHead(500);
              res.end("agent run failed");
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(stdout || "{}");
          });
        } catch (error) {
          api.logger.error(
            `[agentlink-bridge] request error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          res.writeHead(500);
          res.end("server error");
        }
      });

      server.listen(config.port, "0.0.0.0", () => {
        api.logger.info(
          `[agentlink-bridge] listening on :${config.port}${config.path}`,
        );
      });
    };

    const stop = async () => {
      if (server) {
        server.close();
        server = null;
      }
    };

    api.registerService({ id: "agentlink-bridge", start, stop });
  },
};
