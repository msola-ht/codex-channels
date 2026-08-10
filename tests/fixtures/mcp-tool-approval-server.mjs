import { createInterface } from "node:readline";

let pendingToolCallId;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: {
          name: "codexc-mcp-tool-approval-contract",
          version: "1.0.0",
        },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "approval_probe",
          description: ` Emit\n\tapproval details ${"x".repeat(2_100)} `,
          inputSchema: {
            type: "object",
            properties: {
              pull_number: { type: "number" },
            },
          },
        }],
      },
    });
    return;
  }
  if (message.method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        resources: [{
          uri: "contract://status",
          name: "contract-status",
          title: "Contract status",
          description: "Deterministic MCP resource fixture.",
          mimeType: "text/plain",
        }],
      },
    });
    return;
  }
  if (message.method === "resources/templates/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { resourceTemplates: [] },
    });
    return;
  }
  if (message.method === "resources/read") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        contents: [{
          uri: message.params?.uri ?? "contract://status",
          mimeType: "text/plain",
          text: "contract resource ready",
        }],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    pendingToolCallId = message.id;
    send({
      jsonrpc: "2.0",
      id: "approval-probe",
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Allow GitHub to update a pull request?",
        requestedSchema: {
          type: "object",
          properties: {},
        },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "GitHub",
          tool_title: "Update pull request",
          persist: ["session", "always"],
          tool_params_display: [{
            name: "pull_number",
            display_name: "Pull request",
            value: message.params?.arguments?.pull_number ?? null,
          }],
        },
      },
    });
    return;
  }
  if (message.id === "approval-probe" && pendingToolCallId !== undefined) {
    const response = message.result;
    send({
      jsonrpc: "2.0",
      id: pendingToolCallId,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify(response),
        }],
        isError: false,
      },
    });
    pendingToolCallId = undefined;
  }
});
