import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { appServerMcpStatus, FakeTransport } from "./support/json-rpc-fixtures.js";

describe("JsonRpcClient MCP", () => {
    it("maps and paginates MCP status into stable summaries", async () => {
      const transport = new FakeTransport();
      transport.mcpPages = [
        {
          data: [appServerMcpStatus({
            name: "project-tools",
            runtimeStatus: "connected",
            authStatus: "oAuth",
            tools: { search: {}, fetch: {} },
          })],
          nextCursor: "1",
        },
        {
          data: [appServerMcpStatus({
            name: "user-tools",
            authStatus: "bearerToken",
            tools: {},
          })],
          nextCursor: null,
        },
      ];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listMcpServers("thread-1")).resolves.toEqual([
        {
          name: "project-tools",
          runtimeStatus: "connected",
          pluginId: null,
          authStatus: "oAuth",
          toolCount: 2,
        },
        {
          name: "user-tools",
          runtimeStatus: "unknown",
          pluginId: null,
          authStatus: "bearerToken",
          toolCount: 0,
        },
      ]);
      expect(
        transport.sent
          .filter((message) => message.method === "mcpServerStatus/list")
          .map((message) => message.params),
      ).toEqual([
        {
          limit: 100,
          detail: "toolsAndAuthOnly",
          threadId: "thread-1",
        },
        {
          limit: 100,
          detail: "toolsAndAuthOnly",
          threadId: "thread-1",
          cursor: "1",
        },
      ]);
    });

    it("preserves the official unknown MCP authentication status", async () => {
      const transport = new FakeTransport();
      transport.mcpPages = [{
        data: [appServerMcpStatus({ authStatus: "unknown", runtimeStatus: "starting" })],
        nextCursor: null,
      }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listMcpServers()).resolves.toEqual([
        {
          name: "local-tools",
          runtimeStatus: "starting",
          pluginId: null,
          authStatus: "unknown",
          toolCount: 1,
        },
      ]);
    });

    it.each([
      "notStarted",
      "starting",
      "connected",
      "authenticationRequired",
      "failed",
      "cancelled",
      "disabled",
    ] as const)("preserves the official %s MCP runtime status", async (runtimeStatus) => {
      const transport = new FakeTransport();
      transport.mcpPages = [{
        data: [appServerMcpStatus({ runtimeStatus })],
        nextCursor: null,
      }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listMcpServers()).resolves.toEqual([
        expect.objectContaining({ runtimeStatus }),
      ]);
    });

    it.each([
      { name: "missing", value: undefined },
      { name: "invalid", value: "ready" },
      { name: "wrong type", value: 1 },
    ])("fails closed for a $name MCP runtimeStatus", async ({ value }) => {
      const transport = new FakeTransport();
      const status = appServerMcpStatus();
      if (value === undefined) {
        delete status.runtimeStatus;
      } else {
        status.runtimeStatus = value;
      }
      transport.mcpPages = [{ data: [status], nextCursor: null }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listMcpServers())
        .rejects.toThrow("Codex 响应缺少有效 MCP server runtimeStatus");
    });

    it.each([
      { name: "missing", value: undefined },
      { name: "empty", value: "" },
      { name: "whitespace-only", value: "   " },
      { name: "missing marketplace", value: "github" },
      { name: "markdown-shaped", value: "**github**@local" },
      { name: "control", value: "plugin\u0000id" },
      { name: "oversized", value: "x".repeat(257) },
    ])("fails closed for a $name MCP pluginId", async ({ value }) => {
      const transport = new FakeTransport();
      transport.mcpPages = [{
        data: [appServerMcpStatus({ pluginId: value })],
        nextCursor: null,
      }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listMcpServers())
        .rejects.toThrow("Codex 响应缺少有效 MCP server pluginId");
    });

    it("maps full MCP details, starts OAuth, and reads bounded resources", async () => {
      const transport = new FakeTransport();
      transport.mcpPages = [{
        data: [appServerMcpStatus({
          name: "project-tools",
          runtimeStatus: "authenticationRequired",
          pluginId: "github@local",
          authStatus: "notLoggedIn",
          serverInfo: {
            name: "project-tools",
            title: "Project Tools",
            version: "1.2.3",
            description: "Project MCP server",
          },
          tools: {
            search: {
              name: "search",
              title: "Search",
              description: "Search project data",
              annotations: { readOnlyHint: true },
            },
          },
          resources: [{
            uri: "project://readme",
            name: "readme",
            title: "README",
            description: "Project README",
            mimeType: "text/markdown",
          }],
          resourceTemplates: [{
            uriTemplate: "project://files/{path}",
            name: "files",
            title: "Files",
            description: "Project files",
            mimeType: "text/plain",
          }],
        })],
        nextCursor: null,
      }];
      transport.mcpResourceResult = {
        contents: [
          {
            uri: "project://readme",
            mimeType: "text/plain",
            text: "x".repeat(20_001),
          },
          {
            uri: "project://logo",
            mimeType: "image/png",
            blob: "YWJjZA==",
          },
        ],
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listMcpServerDetails("thread-1")).resolves.toEqual([{
        name: "project-tools",
        runtimeStatus: "authenticationRequired",
        pluginId: "github@local",
        authStatus: "notLoggedIn",
        toolCount: 1,
        serverTitle: "Project Tools",
        serverVersion: "1.2.3",
        serverDescription: "Project MCP server",
        tools: [{
          name: "search",
          title: "Search",
          description: "Search project data",
          access: "readOnly",
        }],
        resources: [{
          uri: "project://readme",
          name: "readme",
          title: "README",
          description: "Project README",
          mimeType: "text/markdown",
        }],
        resourceTemplates: [{
          uriTemplate: "project://files/{path}",
          name: "files",
          title: "Files",
          description: "Project files",
          mimeType: "text/plain",
        }],
      }]);
      await expect(client.startMcpOAuthLogin("project-tools", "thread-1"))
        .resolves.toEqual({
          server: "project-tools",
          authorizationUrl: "https://example.test/oauth",
        });
      const resource = await client.readMcpResource(
        "project-tools",
        "project://readme",
        "thread-1",
      );
      expect(resource.contents[0]).toMatchObject({
        kind: "text",
        truncated: true,
      });
      expect(resource.contents[0]).toHaveProperty("text", "x".repeat(8_000));
      expect(resource.contents[1]).toEqual({
        kind: "blob",
        uri: "project://logo",
        mimeType: "image/png",
        encodedCharacters: 8,
      });
      expect(resource.omittedContentCount).toBe(0);
      await expect(client.reloadMcpServers()).resolves.toBeUndefined();
      const reloadRequest = transport.sent.find(
        (message) => message.method === "config/mcpServer/reload",
      );
      expect(reloadRequest).toBeDefined();
      expect(reloadRequest).not.toHaveProperty("params");
      expect(transport.sent.find((message) => message.method === "mcpServerStatus/list")?.params)
        .toEqual({ limit: 100, detail: "full", threadId: "thread-1" });
      expect(transport.sent.find((message) => message.method === "mcpServer/oauth/login")?.params)
        .toEqual({ name: "project-tools", threadId: "thread-1" });
      expect(transport.sent.find((message) => message.method === "mcpServer/resource/read")?.params)
        .toEqual({ server: "project-tools", uri: "project://readme", threadId: "thread-1" });
    });

    it("normalizes multiline and oversized MCP descriptions without rejecting details", async () => {
      const transport = new FakeTransport();
      transport.mcpPages = [{
        data: [appServerMcpStatus({
          serverInfo: {
            name: "local-tools",
            title: "Local Tools",
            version: "1.0.0",
            description: " Server\n\tsummary ",
          },
          tools: {
            search: {
              name: "search",
              title: "Search",
              description: ` Search\n\ttool ${"x".repeat(12_700)} `,
            },
          },
          resources: [{
            uri: "local://readme",
            name: "readme",
            title: "README",
            description: " Resource\n\tsummary ",
            mimeType: "text/plain",
          }],
        })],
        nextCursor: null,
      }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      const [server] = await client.listMcpServerDetails();
      expect(server?.serverDescription).toBe("Server summary");
      expect(server?.tools[0]?.description).toHaveLength(2_000);
      expect(server?.tools[0]?.description).toMatch(/^Search tool x+$/u);
      expect(server?.resources[0]?.description).toBe("Resource summary");
    });

    it.each([
      { name: "NUL", value: "\u0000" },
      { name: "ESC", value: "\u001b" },
    ])("rejects $name in MCP descriptions", async ({ value }) => {
      const transport = new FakeTransport();
      transport.mcpPages = [{
        data: [appServerMcpStatus({
          tools: {
            search: {
              name: "search",
              title: "Search",
              description: `unsafe${value}description`,
            },
          },
        })],
        nextCursor: null,
      }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listMcpServerDetails())
        .rejects.toThrow("Codex 响应缺少有效 MCP tool description");
    });

    it("bounds MCP resource content count and aggregate visible text", async () => {
      const transport = new FakeTransport();
      transport.mcpResourceResult = {
        contents: Array.from({ length: 10 }, (_, index) => ({
          uri: `project://entry/${index + 1}`,
          mimeType: "text/plain",
          text: String(index + 1).repeat(3_000),
        })),
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      const resource = await client.readMcpResource("project-tools", "project://all");
      expect(resource.contents).toHaveLength(3);
      expect(resource.contents.reduce(
        (characters, content) => characters + (content.kind === "text" ? content.text.length : 0),
        0,
      )).toBe(8_000);
      expect(resource.contents.at(-1)).toMatchObject({
        kind: "text",
        truncated: true,
      });
      expect(resource.omittedContentCount).toBe(7);
    });

    it("redacts credentials from MCP resource text before returning it", async () => {
      const transport = new FakeTransport();
      transport.mcpResourceResult = {
        contents: [{
          uri: "project://secrets",
          mimeType: "text/plain",
          text: [
            "Authorization: Bearer bearer-secret",
            "Cookie: session=cookie-secret",
            "API_TOKEN=environment-secret",
          ].join("\n"),
        }],
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      const resource = await client.readMcpResource(
        "project-tools",
        "project://secrets",
      );
      expect(resource.contents[0]).toMatchObject({
        kind: "text",
        text: [
          "Authorization: Bearer [REDACTED]",
          "Cookie: [REDACTED]",
          "API_TOKEN=[REDACTED]",
        ].join("\n"),
      });
      expect(JSON.stringify(resource)).not.toMatch(
        /bearer-secret|cookie-secret|environment-secret/u,
      );
    });

    it("rejects an unsafe MCP OAuth authorization URL", async () => {
      const transport = new FakeTransport();
      transport.mcpOauthResult = { authorizationUrl: "http://example.test/oauth" };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.startMcpOAuthLogin("project-tools"))
        .rejects.toThrow("Codex 响应缺少安全的 MCP OAuth authorization URL");
    });

    it("fails closed when MCP status lacks a required stable field", async () => {
      const transport = new FakeTransport();
      transport.mcpPages = [{
        data: [appServerMcpStatus({ authStatus: "invalid" })],
        nextCursor: null,
      }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listMcpServers())
        .rejects.toThrow("Codex 响应缺少有效 MCP server authStatus");
    });

    it("rejects repeated MCP pagination cursors", async () => {
      const transport = new FakeTransport();
      transport.mcpPages = [{
        data: [],
        nextCursor: "same-cursor",
      }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listMcpServers())
        .rejects.toThrow("mcpServerStatus/list 返回了循环分页游标");
    });
});
