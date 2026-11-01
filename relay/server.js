const http = require("node:http");
const { WebSocketServer, WebSocket } = require("ws");
const { randomUUID } = require("node:crypto");

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 39080;
const HOST = "127.0.0.1";

// Connected devices registry: token -> { ws, info, connectedAt }
const devices = new Map();
// Pending HTTP requests awaiting device response: requestId -> { req, res, timer, startTime }
const pendingRequests = new Map();

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  // 1. CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD, DELETE");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, mcp-session-id, x-mcp-session-id"
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, x-mcp-session-id, content-type");

  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // 2. Health & Status
  if (pathname === "/" || pathname === "/health" || pathname === "/status") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(
      JSON.stringify(
        {
          service: "agent-bridge-relay",
          status: "online",
          version: "1.1.0",
          devicesOnlineCount: devices.size,
          timestamp: new Date().toISOString(),
        },
        null,
        2
      )
    );
    return;
  }

  // 3. MCP Gateway handling (/mcp, /mcp/:deviceToken)
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
    // Extract target device token
    let targetDeviceToken = "";

    // A. Check Authorization: Bearer <token>
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      targetDeviceToken = authHeader.slice(7).trim();
    }

    // B. Check URL query params (?device=xxx or ?token=xxx)
    if (!targetDeviceToken) {
      targetDeviceToken = url.searchParams.get("device") || url.searchParams.get("token") || "";
    }

    // C. Check URL path (/mcp/dev_xxx)
    if (!targetDeviceToken && pathname.startsWith("/mcp/")) {
      const subpath = pathname.slice(5).replace(/\/.*$/, "").trim();
      if (subpath) targetDeviceToken = subpath;
    }

    // Read body
    let bodyText = "";
    for await (const chunk of req) {
      bodyText += chunk;
    }
    let body;
    if (bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }

    // Strict authentication: If no target device token specified, reject with 401 Unauthorized
    if (!targetDeviceToken) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body && body.id ? body.id : null,
          error: {
            code: -32000,
            message:
              "Unauthorized: No valid device token specified. Please configure your device URL as /mcp/<DEVICE_TOKEN> or provide Authorization: Bearer <DEVICE_TOKEN>.",
          },
        })
      );
      return;
    }

    // Check if device is connected
    const deviceEntry = devices.get(targetDeviceToken);
    if (!deviceEntry || deviceEntry.ws.readyState !== WebSocket.OPEN) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body && body.id ? body.id : null,
          error: {
            code: -32001,
            message: `Device '${targetDeviceToken}' is currently offline. Please ensure the agent-bridge client is running on your Mac/PC.`,
          },
        })
      );
      return;
    }

    // Normalize accept header before relaying
    const originalAccept = req.headers["accept"] || "";
    let accept = originalAccept;
    if (!accept.includes("text/event-stream")) {
      accept = accept ? `${accept}, text/event-stream` : "application/json, text/event-stream";
    }

    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        if (!res.headersSent) {
          res.statusCode = 504;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body && body.id ? body.id : null,
              error: { code: -32002, message: "Gateway Timeout: Local device did not respond within 30s" },
            })
          );
        }
      }
    }, 30000);

    pendingRequests.set(requestId, { req, res, timer, startTime });

    // Send request over WebSocket to local device
    deviceEntry.ws.send(
      JSON.stringify({
        type: "mcp_request",
        requestId,
        method,
        pathname,
        headers: {
          ...req.headers,
          accept,
        },
        body,
      })
    );
    return;
  }

  // 4. Default 404
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "Not Found", path: pathname }));
});

// Setup WebSocket Server for local clients
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let token = url.searchParams.get("token") || url.searchParams.get("device") || "";

  console.log(`[WebSocket] Client connected from ${req.socket.remoteAddress}, token: ${token || "(awaiting msg)"}`);

  if (token) {
    devices.set(token, { ws, connectedAt: new Date().toISOString() });
    const masked = token.length > 8 ? `${token.slice(0, 8)}...` : "***";
    console.log(`[Device Registered via URL] Token=${masked} (len=${token.length}), Total active devices=${devices.size}`);
    ws.send(JSON.stringify({ type: "registered", token, status: "online" }));
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "register") {
        token = msg.token || token || `dev_${randomUUID().replace(/-/g, "")}`;
        devices.set(token, { ws, info: msg.info || {}, connectedAt: new Date().toISOString() });
        const masked = token.length > 8 ? `${token.slice(0, 8)}...` : "***";
        console.log(`[Device Registered via Message] Token=${masked} (len=${token.length}), Total active devices=${devices.size}`);
        ws.send(JSON.stringify({ type: "registered", token, status: "online" }));
        return;
      }

      if (msg.type === "mcp_response") {
        const { requestId, statusCode, headers, body } = msg;
        const pending = pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(requestId);

          const { res } = pending;
          res.statusCode = statusCode || 200;
          if (headers) {
            for (const [k, v] of Object.entries(headers)) {
              if (k.toLowerCase() !== "content-length") {
                res.setHeader(k, v);
              }
            }
          }
          if (!res.getHeader("Content-Type")) {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
          }
          const output = typeof body === "object" ? JSON.stringify(body) : String(body || "");
          res.end(output);
        }
        return;
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        return;
      }
    } catch (err) {
      console.error("[WebSocket] Error processing message:", err);
    }
  });

  ws.on("close", () => {
    if (token && devices.get(token)?.ws === ws) {
      devices.delete(token);
      console.log(`[Device Disconnected] Token=${token}, Remaining devices=${devices.size}`);
    }
  });

  ws.on("error", (err) => {
    console.error(`[WebSocket Error] Token=${token}:`, err.message);
  });
});

// Periodic heartbeat ping to keep all device connections alive
setInterval(() => {
  for (const [token, entry] of devices.entries()) {
    if (entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.ping();
    } else {
      devices.delete(token);
    }
  }
}, 15000);

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Agent Bridge Relay Hub listening on http://${HOST}:${PORT}`);
  console.log(`=======================================================`);
});
