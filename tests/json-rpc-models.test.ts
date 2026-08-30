import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { appServerModel, FakeTransport } from "./support/json-rpc-fixtures.js";

describe("JsonRpcClient models", () => {
    it("rejects repeated pagination cursors", async () => {
      const transport = new FakeTransport();
      transport.circularModelCursor = true;
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listModels()).rejects.toThrow("model/list 返回了循环分页游标");
    });

    it("maps the official model catalog to the stable Application model shape", async () => {
      const transport = new FakeTransport();
      transport.modelListData = [
        appServerModel(),
        appServerModel({
          id: "gpt-retiring",
          model: "gpt-retiring",
          multiAgentVersion: "v2",
          upgradeInfo: {
            model: "gpt-next",
            upgradeCopy: "Upgrade",
            modelLink: "https://example.test/model",
            migrationMarkdown: "Do not propagate",
            retirementAt: 1_893_456_000,
          },
        }),
        appServerModel({ id: "hidden", model: "hidden", hidden: true }),
      ];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listModels()).resolves.toEqual([{
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        supportedReasoningEfforts: [{
          effort: "medium",
          description: "Medium",
        }],
        defaultReasoningEffort: "medium",
        serviceTiers: [{
          id: "priority",
          name: "Fast",
        }],
        defaultServiceTier: "default",
        isDefault: true,
        inputModalities: ["text"],
      }, {
        id: "gpt-retiring",
        model: "gpt-retiring",
        displayName: "GPT Test",
        supportedReasoningEfforts: [{
          effort: "medium",
          description: "Medium",
        }],
        defaultReasoningEffort: "medium",
        serviceTiers: [{
          id: "priority",
          name: "Fast",
        }],
        defaultServiceTier: "default",
        isDefault: true,
        inputModalities: ["text"],
        multiAgentVersion: "v2",
        upgrade: {
          model: "gpt-next",
          retirementAtSeconds: 1_893_456_000,
        },
      }]);
    });

    it("fails closed for invalid model lifecycle metadata", async () => {
      const transport = new FakeTransport();
      transport.modelListData = [appServerModel({ multiAgentVersion: "v3" })];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listModels())
        .rejects.toThrow("Codex 响应包含未知 model multiAgentVersion");
    });

    it("fails closed when a model response lacks a required stable field", async () => {
      const transport = new FakeTransport();
      transport.modelListData = [appServerModel({ displayName: undefined })];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listModels())
        .rejects.toThrow("Codex 响应缺少有效 model displayName");
    });

    it("fails closed when a model response contains an unknown input modality", async () => {
      const transport = new FakeTransport();
      transport.modelListData = [appServerModel({ inputModalities: ["text", "video"] })];
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listModels())
        .rejects.toThrow("Codex 响应包含未知 model inputModalities");
    });
  });
