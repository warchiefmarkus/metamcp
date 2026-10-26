import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import mcpProxy from "./mcp-proxy";

describe("mcpProxy protocol negotiation", () => {
  it("applies the downstream initialize response protocol version before subsequent sends", async () => {
    const clientOutbound: JSONRPCMessage[] = [];
    const serverOutbound: Array<{
      message: JSONRPCMessage;
      protocolVersion: string | undefined;
    }> = [];
    let downstreamProtocolVersion: string | undefined;

    const transportToClient: Transport = {
      start: async () => {},
      close: async () => {},
      send: async (message) => {
        clientOutbound.push(message);
      },
    };

    const transportToServer: Transport = {
      start: async () => {},
      close: async () => {},
      send: async (message) => {
        serverOutbound.push({
          message,
          protocolVersion: downstreamProtocolVersion,
        });
      },
      setProtocolVersion: (version) => {
        downstreamProtocolVersion = version;
      },
    };

    mcpProxy({ transportToClient, transportToServer });

    transportToClient.onmessage?.({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "proxy-test", version: "1.0" },
      },
    });

    expect(serverOutbound).toHaveLength(1);
    expect(serverOutbound[0].protocolVersion).toBeUndefined();

    transportToServer.onmessage?.({
      jsonrpc: "2.0",
      id: 7,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "downstream", version: "1.0" },
      },
    });

    expect(downstreamProtocolVersion).toBe("2025-06-18");
    expect(clientOutbound).toHaveLength(1);

    transportToClient.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(serverOutbound).toHaveLength(2);
    expect(serverOutbound[1].protocolVersion).toBe("2025-06-18");
  });
});
