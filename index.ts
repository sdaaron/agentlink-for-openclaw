import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type BridgeConfig = {
  enabled: boolean;
  mode: "push" | "pull" | "both";
  port: number;
  path: string;
  token?: string;
  baseUrl?: string;
  agentToken?: string;
  pollInterval?: number;
  cursorFile?: string;
};

const configSchema = {
  parse(value: unknown): BridgeConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
    const mode =
      raw.mode === "pull" || raw.mode === "both" ? raw.mode : "push";
    const port = typeof raw.port === "number" ? raw.port : 8787;
    const path = typeof raw.path === "string" ? raw.path : "/agentlink/message";
    const token = typeof raw.token === "string" ? raw.token : undefined;
    const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : undefined;
    const agentToken =
      typeof raw.agentToken === "string" ? raw.agentToken : undefined;
    const pollInterval =
      typeof raw.pollInterval === "number" ? raw.pollInterval : 2;
    const cursorFile =
      typeof raw.cursorFile === "string"
        ? raw.cursorFile
        : path.join(os.homedir(), ".openclaw", "agentlink-cursor.json");
    return {
      enabled,
      mode,
      port,
      path,
      token,
      baseUrl,
      agentToken,
      pollInterval,
      cursorFile,
    };
  },
  uiHints: {
    enabled: { label: "Enabled" },
    mode: { label: "Mode (push/pull/both)" },
    port: { label: "Listen Port" },
    path: { label: "Listen Path" },
    token: { label: "AgentLink Token", sensitive: true },
    baseUrl: { label: "AgentLink Base URL" },
    agentToken: { label: "Agent Token (X-Agent-Token)", sensitive: true },
    pollInterval: { label: "Poll Interval (seconds)" },
    cursorFile: { label: "Cursor File Path" },
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCursor(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { cursor?: string };
    if (parsed && typeof parsed.cursor === "string" && parsed.cursor.length > 0) {
      return parsed.cursor;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function saveCursor(filePath: string, cursor: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ cursor }), "utf-8");
  } catch {
    return;
  }
}

async function runAgent(api: any, message: string, sessionId?: string) {
  const args = ["agent", "--message", message, "--json"];
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  return new Promise<void>((resolve) => {
    execFile("openclaw", args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        api.logger.error(
          `[agentlink-bridge] openclaw agent failed: ${stderr || err.message}`,
        );
        resolve();
        return;
      }
      if (stdout) {
        api.logger.info("[agentlink-bridge] agent response delivered");
      }
      resolve();
    });
  });
}

async function startPullStream(api: any, config: BridgeConfig) {
  if (typeof fetch !== "function") {
    api.logger.error("[agentlink-bridge] fetch not available; cannot pull");
    return { stop: async () => undefined };
  }
  if (!config.baseUrl || !config.agentToken) {
    api.logger.warn("[agentlink-bridge] missing baseUrl/agentToken for pull mode");
    return { stop: async () => undefined };
  }
  let stopped = false;
  let cursor = loadCursor(config.cursorFile || "");
  let backoffMs = 1000;
  const controller = new AbortController();
  const decoder = new TextDecoder();

  const connect = async () => {
    while (!stopped) {
      try {
        const url = new URL("/messages/stream", config.baseUrl);
        if (cursor) {
          url.searchParams.set("cursor", cursor);
        }
        if (config.pollInterval) {
          url.searchParams.set("poll_interval", String(config.pollInterval));
        }
        api.logger.info(`[agentlink-bridge] SSE connect ${url.toString()}`);
        const res = await fetch(url, {
          headers: { "X-Agent-Token": config.agentToken },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          api.logger.warn(
            `[agentlink-bridge] SSE failed: ${res.status} ${res.statusText}`,
          );
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 15000);
          continue;
        }
        backoffMs = 1000;
        let buffer = "";
        const reader = res.body.getReader();
        while (!stopped) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          buffer += decoder.decode(result.value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            const lines = part.split("\n");
            let event = "message";
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith("event:")) {
                event = line.slice(6).trim();
                continue;
              }
              if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
              }
            }
            const dataText = dataLines.join("\n");
            if (!dataText) {
              continue;
            }
            if (event === "message") {
              const payload = JSON.parse(dataText);
              const fromAgent =
                typeof payload.from_agent_id === "string"
                  ? payload.from_agent_id
                  : "unknown";
              const content =
                typeof payload.content === "string" ? payload.content : "";
              const sessionId =
                typeof payload.sessionId === "string"
                  ? payload.sessionId
                  : `agentlink:${fromAgent}`;
              if (payload.cursor && typeof payload.cursor === "string") {
                cursor = payload.cursor;
                if (config.cursorFile) {
                  saveCursor(config.cursorFile, cursor);
                }
              }
              if (content) {
                const message = `From ${fromAgent}: ${content}`;
                await runAgent(api, message, sessionId);
              }
            } else if (event === "ping") {
              const payload = JSON.parse(dataText);
              if (payload.cursor && typeof payload.cursor === "string") {
                cursor = payload.cursor;
                if (config.cursorFile) {
                  saveCursor(config.cursorFile, cursor);
                }
              }
            } else if (event === "error") {
              api.logger.warn(`[agentlink-bridge] SSE error: ${dataText}`);
            }
          }
        }
      } catch (error) {
        if (!stopped) {
          api.logger.warn(
            `[agentlink-bridge] SSE disconnected: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 15000);
    }
  };

  connect();

  return {
    stop: async () => {
      stopped = true;
      controller.abort();
    },
  };
}

export default {
  id: "agentlink-bridge",
  name: "AgentLink Bridge",
  description: "Receive AgentLink messages and trigger OpenClaw agent runs.",
  configSchema,
  register(api: any) {
    const config = configSchema.parse(api.pluginConfig);
    let server: http.Server | null = null;
    let pullHandle: { stop: () => Promise<void> } | null = null;

    const startPush = async () => {
      if (!config.token) {
        api.logger.warn("[agentlink-bridge] missing token for push mode");
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
          const message =
            typeof payload.message === "string" ? payload.message.trim() : "";
          const sessionId =
            typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
          if (!message) {
            res.writeHead(400);
            res.end("message required");
            return;
          }
          await runAgent(api, message, sessionId || undefined);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
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
          `[agentlink-bridge] push listening on :${config.port}${config.path}`,
        );
      });
    };

    const start = async () => {
      if (!config.enabled) {
        api.logger.info("[agentlink-bridge] disabled by config");
        return;
      }
      if (config.mode === "push" || config.mode === "both") {
        await startPush();
      }
      if (config.mode === "pull" || config.mode === "both") {
        pullHandle = await startPullStream(api, config);
      }
    };

    const stop = async () => {
      if (server) {
        server.close();
        server = null;
      }
      if (pullHandle) {
        await pullHandle.stop();
        pullHandle = null;
      }
    };

    api.registerService({ id: "agentlink-bridge", start, stop });
  },
};
