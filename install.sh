#!/bin/sh

set -eu

repository="https://github.com/msola-ht/codex-channels.git"

usage() {
  cat <<'EOF'
用法：install.sh

把 Codex Connect 的 main 分支安装到 ~/.codex-connect/codex-channels。
只支持 Linux 与 macOS。
EOF
}

fail() {
  printf '%s\n' "[失败] $*" >&2
  exit 1
}

note() {
  printf '%s\n' "[提示] $*"
}

success() {
  printf '%s\n' "[成功] $*"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
done

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) fail "源码安装当前只支持 Linux 与 macOS" ;;
esac

[ -n "${HOME:-}" ] || fail "HOME 未设置"
for command in git node npm; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少必需命令：$command"
done

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) process.exit(1);
' || fail "Node.js 版本过低；需要 22.13.0 或更高版本"

npm_version="$(npm --version 2>/dev/null)" || fail "无法读取 npm 版本"
npm_global_root="$(npm root --global 2>/dev/null)" || fail "无法读取 npm 全局安装目录"
npm_global_prefix="$(npm prefix --global 2>/dev/null)" || fail "无法读取 npm 全局安装前缀"
case "$npm_global_root" in
  /*) ;;
  *) fail "npm 全局安装目录不是绝对路径：$npm_global_root" ;;
esac
case "$npm_global_prefix" in
  /*) ;;
  *) fail "npm 全局安装前缀不是绝对路径：$npm_global_prefix" ;;
esac
npm_codexc_manifest="$npm_global_root/@hegenai/codexc/package.json"
current_codexc="$(command -v codexc 2>/dev/null || true)"
note "npm 检测通过：${npm_version}；全局目录：${npm_global_root}"
if [ -f "$npm_codexc_manifest" ]; then
  npm_codexc_version="$(node -e '
import { readFileSync } from "node:fs";
const metadata = JSON.parse(readFileSync(process.argv[1], "utf8"));
process.stdout.write(typeof metadata.version === "string" ? metadata.version : "未知");
' "$npm_codexc_manifest" 2>/dev/null || printf '%s' '未知')"
  note "检测到 npm 全局版 @hegenai/codexc@${npm_codexc_version}；将由当前 main 构建替换。"
elif [ -n "$current_codexc" ]; then
  note "未检测到 npm 全局版；当前已有 codexc 命令：$current_codexc"
else
  note "未检测到 npm 全局版 @hegenai/codexc。"
fi

install_root="${CODEX_CONNECT_HOME:-$HOME/.codex-connect}"
case "$install_root" in
  /*) ;;
  *) fail "CODEX_CONNECT_HOME 必须是绝对路径" ;;
esac
checkout="$install_root/codex-channels"
global_launcher="$npm_global_prefix/bin/codexc"

if [ -e "$checkout" ] || [ -L "$checkout" ]; then
  fail "源码目录已存在：${checkout}；已有源码安装请使用 codexc update"
fi
mkdir -p "$install_root"
chmod 700 "$install_root"
staging="$(mktemp -d "$install_root/.codex-channels-install.XXXXXX")"
completed=false
cleanup() {
  if [ -n "${staging:-}" ] && [ -d "$staging" ]; then
    rm -rf "$staging"
  fi
  if [ "$completed" != true ]; then
    if [ -d "$checkout" ]; then
      rm -rf "$checkout"
    fi
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

note "正在克隆 Codex Connect main 到 $checkout"
git clone --quiet --branch main --single-branch "$repository" "$staging/repository" \
  || fail "无法克隆官方 main 分支"

version="$(node -e '
import { readFileSync } from "node:fs";
const metadata = JSON.parse(readFileSync(process.argv[1], "utf8"));
const value = typeof metadata.codexCli === "string" ? metadata.codexCli : "";
const version = value.startsWith("codex-cli ") ? value.slice("codex-cli ".length) : "";
if (!/^\d+\.\d+\.\d+$/u.test(version)) process.exit(1);
process.stdout.write(version);
' "$staging/repository/src/codex-protocol/version.json")"
codex_command="$(command -v codex 2>/dev/null || true)"
if [ -z "$codex_command" ]; then
  note "未检测到 Codex CLI，正在安装 @openai/codex@$version"
  npm install --global --no-audit --no-fund "@openai/codex@$version" \
    || fail "Codex CLI 安装失败；请检查 npm 全局目录权限"
  codex_command="$(command -v codex 2>/dev/null || true)"
  [ -n "$codex_command" ] \
    || fail "Codex CLI 已安装到 $npm_global_prefix/bin，但该目录不在 PATH；请加入 PATH 后重新运行"
  success "Codex CLI $version 已安装。"
fi
codex_version="$($codex_command --version 2>/dev/null | awk '{ print $NF }')"
codex_version="${codex_version#v}"
[ "$codex_version" = "$version" ] \
  || fail "Codex CLI 版本不匹配：main 需要 ${version}，当前 ${codex_version:-未知}"
if "$codex_command" login status >/dev/null 2>&1; then
  codex_logged_in=true
  note "Codex CLI 检测通过：$codex_command · $codex_version · 已登录"
else
  codex_logged_in=false
  note "Codex CLI 检测通过：$codex_command · $codex_version · 未登录或登录状态不可用"
fi

print_next_steps() {
  if [ "$codex_logged_in" = true ]; then
    printf '%s\n' "下一步：codexc init && codexc setup && codexc service install"
  else
    printf '%s\n' "下一步：codex login status"
    printf '%s\n' "如未登录：codex login"
    printf '%s\n' "登录后执行：codexc init && codexc setup && codexc service install"
  fi
}

note "正在安装依赖并构建 Gateway"
(cd "$staging/repository" \
  && npm ci --no-audit --no-fund \
  && npm run build \
  && npm run check) \
  || fail "Gateway 依赖安装或构建失败"
note "正在安装依赖并构建 WebUI"
(cd "$staging/repository/webui" \
  && npm ci --ignore-scripts --no-audit --no-fund \
  && npm run build) \
  || fail "WebUI 依赖安装或构建失败"

[ -f "$staging/repository/dist/main.js" ] || fail "构建结果缺少 dist/main.js"
[ -f "$staging/repository/webui/dist/index.html" ] \
  || fail "构建结果缺少 webui/dist/index.html"

git -C "$staging/repository" config --local codex-connect.managed-source true \
  || fail "无法标记受管源码安装"
git -C "$staging/repository" config --local codex-connect.npm-prefix "$npm_global_prefix" \
  || fail "无法记录 npm 全局目录"
mv "$staging/repository" "$checkout"
package_directory="$staging/package"
mkdir -p "$package_directory"
pack_report="$(cd "$checkout" && npm pack --ignore-scripts --loglevel=error --json --pack-destination "$package_directory")" \
  || fail "Codex Connect 源码打包失败"
tarball="$(printf '%s' "$pack_report" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const report = JSON.parse(input);
  const entry = Array.isArray(report) ? report[0] : Object.values(report)[0];
  if (!entry?.filename) process.exit(1);
  process.stdout.write(entry.filename);
});
')" || fail "npm pack 未返回 tarball 文件名"
npm install --global --ignore-scripts --loglevel=error --no-audit --no-fund "$package_directory/$tarball" \
  >/dev/null || fail "Codex Connect npm 全局命令安装失败；请检查 npm 全局目录权限"
[ -x "$global_launcher" ] \
  || fail "npm 全局命令入口不存在：$global_launcher"
completed=true
node "$checkout/scripts/source-shell-path.mjs" remove \
  || note "旧 Shell PATH 配置清理失败；可手工删除 Codex Connect 配置块。"

rm -rf "$staging"
staging=""
success "Codex Connect Git 源码已安装：$checkout"
printf '%s\n' "分支：main"
success "npm 全局命令已安装：$global_launcher"
print_next_steps
