import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { FakeTransport } from "./support/json-rpc-fixtures.js";

describe("JsonRpcClient config", () => {
    it("maps and paginates Permission Profiles into stable options", async () => {
      const transport = new FakeTransport();
      transport.permissionPages = [
        {
          data: [{
            id: ":read-only",
            description: null,
            allowed: true,
          }],
          nextCursor: "1",
        },
        {
          data: [{
            id: "project",
            description: "Project policy",
            allowed: false,
          }],
          nextCursor: null,
        },
      ];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listPermissionProfiles("/tmp/project")).resolves.toEqual([
        { id: ":read-only", description: null, allowed: true },
        { id: "project", description: "Project policy", allowed: false },
      ]);
      expect(
        transport.sent
          .filter((message) => message.method === "permissionProfile/list")
          .map((message) => message.params),
      ).toEqual([
        { cwd: "/tmp/project", limit: 100 },
        { cwd: "/tmp/project", limit: 100, cursor: "1" },
      ]);
    });

    it("fails closed when a Permission Profile lacks a required stable field", async () => {
      const transport = new FakeTransport();
      transport.permissionPages = [{
        data: [{ id: "", description: null, allowed: true }],
        nextCursor: null,
      }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listPermissionProfiles("/tmp/project"))
        .rejects.toThrow("Codex 响应缺少有效 permission profile id");
    });

    it("rejects repeated Permission Profile pagination cursors", async () => {
      const transport = new FakeTransport();
      transport.permissionPages = [{ data: [], nextCursor: "same-cursor" }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listPermissionProfiles("/tmp/project"))
        .rejects.toThrow("permissionProfile/list 返回了循环分页游标");
    });

    it("persists the Fast default through the App Server config API", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await client.writeDefaultFastMode(false);
      await client.writeDefaultFastMode(true);

      expect(
        transport.sent
          .filter((message) => message.method === "config/batchWrite")
          .map((message) => message.params),
      ).toEqual([
        {
          edits: [{
            keyPath: "service_tier",
            value: "default",
            mergeStrategy: "replace",
          }],
          reloadUserConfig: true,
        },
        {
          edits: [{
            keyPath: "service_tier",
            value: "fast",
            mergeStrategy: "replace",
          }],
          reloadUserConfig: true,
        },
      ]);
    });

    it("persists the default model and reasoning effort as one App Server config write", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await client.writeDefaultModelSettings("gpt-test", "high");

      expect(
        transport.sent
          .filter((message) => message.method === "config/batchWrite")
          .map((message) => message.params),
      ).toEqual([{
        edits: [{
          keyPath: "model",
          value: "gpt-test",
          mergeStrategy: "replace",
        }, {
          keyPath: "model_reasoning_effort",
          value: "high",
          mergeStrategy: "replace",
        }],
        reloadUserConfig: true,
      }]);
    });

    it("writes structured user settings and removals through one config transaction", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await client.writeUserConfigEdits([{
        keyPath: "features.multi_agent_v2",
        value: true,
      }, {
        keyPath: "agents.external",
        value: {
          description: "DeepSeek role",
          config_file: "/tmp/ds.toml",
          nickname_candidates: ["DeepSeek"],
        },
      }, {
        keyPath: "agents.old",
        value: null,
      }]);

      expect(transport.sent.find((message) => message.method === "config/batchWrite")?.params)
        .toEqual({
          edits: [{
            keyPath: "features.multi_agent_v2",
            value: true,
            mergeStrategy: "replace",
          }, {
            keyPath: "agents.external",
            value: {
              description: "DeepSeek role",
              config_file: "/tmp/ds.toml",
              nickname_candidates: ["DeepSeek"],
            },
            mergeStrategy: "replace",
          }, {
            keyPath: "agents.old",
            value: null,
            mergeStrategy: "replace",
          }],
          reloadUserConfig: true,
        });
    });

    it("reads the raw user config layer and guards a subsequent config write by version", async () => {
      const transport = new FakeTransport();
      transport.configLayers = [{
        name: { type: "user", file: "/tmp/config.toml", profile: null },
        version: "sha256:current",
        config: { agents: { ds: { config_file: "/tmp/ds.toml" } } },
        disabledReason: null,
      }];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.readUserConfigSnapshot()).resolves.toEqual({
        config: { agents: { ds: { config_file: "/tmp/ds.toml" } } },
        version: "sha256:current",
      });
      await client.writeUserConfigEdits(
        [{ keyPath: "agents.external", value: null }],
        { expectedVersion: "sha256:current" },
      );

      expect(transport.sent.find((message) => message.method === "config/read")?.params)
        .toEqual({ includeLayers: true });
      expect(transport.sent.find((message) => message.method === "config/batchWrite")?.params)
        .toMatchObject({ expectedVersion: "sha256:current" });
    });

    it("reads the default model and reasoning effort through the App Server config API", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.readDefaultModelSettings()).resolves.toEqual({
        model: "gpt-test",
        effort: "high",
      });
      expect(transport.sent.find((message) => message.method === "config/read")?.params)
        .toEqual({ includeLayers: false });
    });

    it("reads the effective reasoning effort for a Workspace through the App Server config API", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.readDefaultReasoningEffort("/tmp/project")).resolves.toBe("high");
      expect(transport.sent.find((message) => message.method === "config/read")?.params)
        .toEqual({ cwd: "/tmp/project", includeLayers: false });
    });

    it("maps the effective Fast config to a stable service-tier value", async () => {
      const transport = new FakeTransport();
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      const result = await client.readDefaultServiceTier("/tmp/project");

      expect(result).toBe("fast");
      expect(transport.sent.find((message) => message.method === "config/read")?.params)
        .toEqual({ cwd: "/tmp/project", includeLayers: false });
    });

    it("fails closed when the effective Fast config has an invalid service tier", async () => {
      const transport = new FakeTransport();
      transport.configServiceTier = 1;
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.readDefaultServiceTier("/tmp/project"))
        .rejects.toThrow("Codex 响应缺少有效 config service_tier");
    });
});
