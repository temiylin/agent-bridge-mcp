import { createBridgeMcpServer } from "./server.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export interface RelayClientOptions {
  serverUrl?: string;
  token?: string;
  customRootDir?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export interface RelayClientHandle {
  close: () => void;
  token: string;
}

/**
 * Connects the local agent-bridge-mcp to a remote Cloud Relay Hub (e.g. wss://bridge.krow.top/ws)
 * through an outbound WebSocket tunnel.
 *
 * This allows ChatGPT anywhere in the world to securely access this local device using
 * the user's personal Bearer token, without opening any local inbound ports.
 */
export async function startRelayClient(options: RelayClientOptions = {}): Promise<RelayClientHandle> {
  const serverUrl = options.serverUrl || process.env.RELAY_SERVER || "wss://bridge.krow.top/ws";
  const token = options.token || process.env.DEVICE_TOKEN || "dev_news";

  let shouldReconnect = true;
  let activeWs: any = null;

  const instance = createBridgeMcpServer(options.customRootDir);
  const { logger } = instance;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverTransport);
  await clientTransport.start();

  const pendingRequests = new Map<string | number, { requestId: string }>();

  clientTransport.onmessage = (msg: any) => {
    const id = msg.id;
    if (id !== undefined && pendingRequests.has(id)) {
      const { requestId } = pendingRequests.get(id)!;
      pendingRequests.delete(id);
      if (activeWs && activeWs.readyState === 1 /* OPEN */) {
        activeWs.send(
          JSON.stringify({
            type: "mcp_response",
            requestId,
            statusCode: 200,
            body: msg,
          })
        );
      }
    }
  };

  function connect() {
    logger.info(`Connecting to Relay Hub at ${serverUrl} with token: ${token}...`);
    const ws = new (globalThis as any).WebSocket(`${serverUrl}?token=${encodeURIComponent(token)}`);
    activeWs = ws;

    ws.onopen = () => {
      logger.info(`✅ Successfully connected to Relay Hub at ${serverUrl}`);
      console.log(`\n===============================================================`);
      console.log(`🎉 已成功连接到 Agent Bridge 云端中继网关！`);
      console.log(`===============================================================`);
      console.log(`📡 云端统一域名:   https://bridge.krow.top/mcp`);
      console.log(`🔑 你的设备识别码: \x1b[32m\x1b[1m${token}\x1b[0m`);
      console.log(`---------------------------------------------------------------`);
      console.log(`💡 在 ChatGPT「添加自定义 MCP 服务器」中：`);
      console.log(`   - 服务器 URL:   https://bridge.krow.top/mcp`);
      console.log(`   - 身份验证:     Bearer Token (填入你的识别码: ${token})`);
      console.log(`===============================================================\n`);
      options.onConnect?.();
    };

    ws.onmessage = async (event: any) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "mcp_request") {
          const { requestId, body } = payload;
          if (body && body.id !== undefined) {
            pendingRequests.set(body.id, { requestId });
            await clientTransport.send(body);
          } else {
            ws.send(
              JSON.stringify({
                type: "mcp_response",
                requestId,
                statusCode: 200,
                body: { jsonrpc: "2.0", result: {} },
              })
            );
          }
        }
      } catch (err: any) {
        logger.error(`Error processing relay request: ${err?.message || String(err)}`);
      }
    };

    ws.onclose = () => {
      options.onDisconnect?.();
      if (shouldReconnect) {
        logger.warn(`Connection to Relay Hub lost. Reconnecting in 3 seconds...`);
        setTimeout(connect, 3000);
      }
    };

    ws.onerror = (err: any) => {
      logger.error(`WebSocket error: ${err?.message || String(err)}`);
    };
  }

  connect();

  return {
    token,
    close: () => {
      shouldReconnect = false;
      if (activeWs) {
        activeWs.close();
      }
    },
  };
}
