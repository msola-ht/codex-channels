import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { appServerPlugin, FakeTransport } from "./support/json-rpc-fixtures.js";

describe("JsonRpcClient skills and plugins", () => {
    it("maps only directly installed user and repo Skills", async () => {
      const transport = new FakeTransport();
      transport.skillsResult = {
        data: [{
          cwd: "/tmp/project",
          errors: [],
          skills: [
            {
              name: "personal",
              description: "Personal",
              path: "/Users/test/.codex/skills/personal/SKILL.md",
              scope: "user",
              enabled: true,
              pluginId: null,
            },
            {
              name: "repo",
              description: "Repository",
              path: "/tmp/project/.codex/skills/repo/SKILL.md",
              scope: "repo",
              enabled: true,
              pluginId: null,
            },
            {
              name: "plugin:cached",
              description: "Plugin",
              path: "/Users/test/.codex/plugins/cache/plugin/skills/cached/SKILL.md",
              scope: "user",
              enabled: true,
              pluginId: "plugin@local",
            },
            {
              name: "system",
              description: "System",
              path: "/Users/test/.codex/skills/.system/system/SKILL.md",
              scope: "system",
              enabled: true,
              pluginId: null,
            },
            {
              name: "disabled",
              description: "Disabled",
              path: "/Users/test/.codex/skills/disabled/SKILL.md",
              scope: "user",
              enabled: false,
              pluginId: null,
            },
          ],
        }, {
          cwd: "/tmp/other",
          errors: [],
          skills: [{
            name: "repo",
            description: "Other repository",
            path: "/tmp/other/.codex/skills/repo/SKILL.md",
            scope: "repo",
            enabled: true,
            pluginId: null,
          }],
        }],
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listSkills("/tmp/project")).resolves.toEqual([
        { name: "personal", description: "Personal" },
        { name: "repo", description: "Repository" },
      ]);
      await expect(client.resolveSkill("/tmp/project", "repo")).resolves.toEqual({
        name: "repo",
        path: "/tmp/project/.codex/skills/repo/SKILL.md",
      });
      await expect(client.resolveSkill("/tmp/project", "system"))
        .resolves.toBeUndefined();
      expect(transport.sent.find((message) => message.method === "skills/list")?.params)
        .toEqual({ cwds: ["/tmp/project"], forceReload: false });
    });

    it("fails closed when an installed Skill lacks a required display field", async () => {
      const transport = new FakeTransport();
      transport.skillsResult = {
        data: [{
          cwd: "/tmp/project",
          errors: [],
          skills: [{
            name: "",
            description: "Broken",
            path: "/Users/test/.codex/skills/broken/SKILL.md",
            scope: "user",
            enabled: true,
            pluginId: null,
          }],
        }],
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listSkills("/tmp/project"))
        .rejects.toThrow("Codex 响应缺少有效 skill name");
    });

    it("lists installed Plugins and resolves only enabled available entries", async () => {
      const transport = new FakeTransport();
      transport.pluginInstalledResult = {
        marketplaces: [{
          name: "local",
          plugins: [
            appServerPlugin(),
            appServerPlugin({
              id: "disabled@local",
              name: "disabled",
              enabled: false,
              authPolicy: "ON_INSTALL",
              interface: null,
            }),
            appServerPlugin({
              id: "admin-blocked@local",
              name: "admin-blocked",
              availability: "DISABLED_BY_ADMIN",
              disabledReason: "plan_not_eligible",
              eligiblePlanTypes: ["plus", "pro", "enterprise_cbp_automation"],
            }),
            appServerPlugin({
              id: "not-installed@local",
              name: "not-installed",
              installed: false,
            }),
          ],
        }],
        marketplaceLoadErrors: [],
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listPlugins("/tmp/project")).resolves.toEqual({
        plugins: [{
          id: "github@local",
          name: "github",
          displayName: "GitHub",
          marketplaceName: "local",
          description: "GitHub development tools",
          enabled: true,
          available: true,
          version: "0.1.8",
          localVersion: "0.1.8",
          source: "local",
          installedAt: 1_786_294_800,
          developerName: "OpenAI",
          category: "Developer tools",
          capabilities: ["Repository inspection", "Pull request management"],
          authPolicy: "onUse",
          eligiblePlanTypes: [],
          disabledReason: null,
        },
        {
          id: "disabled@local",
          name: "disabled",
          displayName: "disabled",
          marketplaceName: "local",
          description: null,
          enabled: false,
          available: true,
          version: "0.1.8",
          localVersion: "0.1.8",
          source: "local",
          installedAt: 1_786_294_800,
          developerName: null,
          category: null,
          capabilities: [],
          authPolicy: "onInstall",
          eligiblePlanTypes: [],
          disabledReason: null,
        },
        {
          id: "admin-blocked@local",
          name: "admin-blocked",
          displayName: "GitHub",
          marketplaceName: "local",
          description: "GitHub development tools",
          enabled: true,
          available: false,
          version: "0.1.8",
          localVersion: "0.1.8",
          source: "local",
          installedAt: 1_786_294_800,
          developerName: "OpenAI",
          category: "Developer tools",
          capabilities: ["Repository inspection", "Pull request management"],
          authPolicy: "onUse",
          eligiblePlanTypes: ["plus", "pro", "enterprise_cbp_automation"],
          disabledReason: "plan_not_eligible",
        }],
        loadErrorCount: 0,
      });
      await expect(client.resolvePlugin("/tmp/project", "github@local"))
        .resolves.toEqual({
          id: "github@local",
          name: "github",
          displayName: "GitHub",
          path: "plugin://github@local",
        });
      await expect(client.resolvePlugin("/tmp/project", "disabled@local"))
        .resolves.toBeUndefined();
      await expect(client.resolvePlugin("/tmp/project", "admin-blocked@local"))
        .resolves.toBeUndefined();
      expect(transport.sent.find((message) => message.method === "plugin/installed")?.params)
        .toEqual({ cwds: ["/tmp/project"] });
    });

    it("preserves a bounded count when Plugin marketplaces only partially load", async () => {
      const transport = new FakeTransport();
      transport.pluginInstalledResult = {
        marketplaces: [{
          name: "local",
          plugins: [appServerPlugin()],
        }],
        marketplaceLoadErrors: [
          { marketplacePath: "/private/one.json", message: "secret one" },
          { marketplacePath: "/private/two.json", message: "secret two" },
        ],
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listPlugins("/tmp/project")).resolves.toEqual({
        plugins: [expect.objectContaining({ id: "github@local" })],
        loadErrorCount: 2,
      });
    });

    it("fails closed when an installed Plugin id does not match its marketplace", async () => {
      const transport = new FakeTransport();
      transport.pluginInstalledResult = {
        marketplaces: [{
          name: "local",
          plugins: [appServerPlugin({ id: "github@other" })],
        }],
        marketplaceLoadErrors: [],
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listPlugins("/tmp/project"))
        .rejects.toThrow("Codex 响应包含不一致的 plugin id");
    });

    it("fails closed when an installed Plugin has an unknown auth policy", async () => {
      const transport = new FakeTransport();
      transport.pluginInstalledResult = {
        marketplaces: [{
          name: "local",
          plugins: [appServerPlugin({ authPolicy: "SOMETIMES" })],
        }],
        marketplaceLoadErrors: [],
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.listPlugins("/tmp/project"))
        .rejects.toThrow("Codex 响应缺少有效 plugin authPolicy");
    });

    it("fails closed when an invocable Skill has an unsafe name or path", async () => {
      const transport = new FakeTransport();
      transport.skillsResult = {
        data: [{
          cwd: "/tmp/project",
          errors: [],
          skills: [{
            name: "unsafe skill",
            description: "Broken",
            path: "relative/SKILL.md",
            scope: "repo",
            enabled: true,
            pluginId: null,
          }],
        }],
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.resolveSkill("/tmp/project", "unsafe skill"))
        .rejects.toThrow("Codex 返回了无法安全调用的 Skill");
    });
});
