import type { FeishuCardDocument } from "./approval-card.js";

export function renderFeishuOAuthCard(
  verificationUriComplete: string,
  scopes: readonly string[],
  expiresInSeconds: number,
): FeishuCardDocument {
  const inAppUrl = toFeishuInAppUrl(verificationUriComplete);
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "请授权飞书账号",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            "授权后，Codex Gateway 可以使用当前飞书账号执行已开通的用户级能力。",
            "",
            `本次请求 ${scopes.length} 项权限，授权链接约 ${
              Math.max(1, Math.round(expiresInSeconds / 60))
            } 分钟后失效。`,
            "",
            "请求的 Scope：",
            ...scopes.map((scope) => `- ${scope}`),
          ].join("\n"),
        },
      },
      {
        tag: "action",
        actions: [{
          tag: "button",
          type: "primary",
          text: {
            tag: "plain_text",
            content: "在飞书内授权",
          },
          multi_url: {
            url: inAppUrl,
            pc_url: inAppUrl,
            android_url: inAppUrl,
            ios_url: inAppUrl,
          },
        }],
      },
    ],
  };
}

export function renderFeishuOAuthOutcomeCard(
  outcome: "success" | "denied" | "expired" | "identity-mismatch" | "failed",
): FeishuCardDocument {
  const successful = outcome === "success";
  const descriptions = {
    success: "授权成功，凭据已安全保存。",
    denied: "你拒绝了本次授权。",
    expired: "授权请求已过期，请重新使用需要该权限的飞书功能。",
    "identity-mismatch": "完成授权的账号与发起人不一致，凭据未保存。",
    failed: "授权处理失败，请稍后重试。",
  } as const;
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: successful ? "green" : "grey",
      title: {
        tag: "plain_text",
        content: successful ? "飞书授权成功" : "飞书授权未完成",
      },
    },
    elements: [{
      tag: "div",
      text: {
        tag: "plain_text",
        content: descriptions[outcome],
      },
    }],
  };
}

export function toFeishuInAppUrl(targetUrl: string): string {
  let trustedTarget: URL;
  try {
    trustedTarget = new URL(targetUrl);
  } catch {
    throw new Error("飞书 OAuth 授权地址无效");
  }
  if (
    targetUrl.length > 2_048
    || (
      trustedTarget.origin !== "https://accounts.feishu.cn"
      && trustedTarget.origin !== "https://open.feishu.cn"
    )
    || trustedTarget.username
    || trustedTarget.password
  ) {
    throw new Error("飞书 OAuth 授权地址无效");
  }
  const normalizedTarget = trustedTarget.toString();
  const metadata = encodeURIComponent(JSON.stringify({
    "page-meta": {
      showNavBar: "false",
      showBottomNavBar: "false",
    },
  }));
  const separator = normalizedTarget.includes("?") ? "&" : "?";
  return "https://applink.feishu.cn/client/web_url/open"
    + "?mode=sidebar-semi&max_width=800&reload=false&url="
    + encodeURIComponent(`${normalizedTarget}${separator}lk_meta=${metadata}`);
}
