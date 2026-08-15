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
  note "检测到 npm 全局版 @hegenai/codexc@${npm_codexc_version}；不会自动卸载。"
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
launcher_dir="$install_root/.bin"
launcher="$launcher_dir/codexc"

if [ -e "$checkout" ] || [ -L "$checkout" ]; then
  fail "源码目录已存在：${checkout}；已有源码安装请使用 codexc update"
fi
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  fail "命令入口已存在：${launcher}；请先确认它是否属于旧安装"
fi

mkdir -p "$install_root" "$launcher_dir"
chmod 700 "$install_root" "$launcher_dir"
staging="$(mktemp -d "$install_root/.codex-channels-install.XXXXXX")"
completed=false
launcher_tmp=""
cleanup() {
  if [ -n "${staging:-}" ] && [ -d "$staging" ]; then
    rm -rf "$staging"
  fi
  if [ "$completed" != true ]; then
    if [ -n "${launcher_tmp:-}" ]; then
      rm -f "$launcher_tmp"
    fi
    rm -f "$launcher"
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

package_version="$(node -e '
import { readFileSync } from "node:fs";
const metadata = JSON.parse(readFileSync(process.argv[1], "utf8"));
const version = typeof metadata.version === "string" ? metadata.version : "";
if (!/^\d+\.\d+\.\d+$/u.test(version)) process.exit(1);
process.stdout.write(version);
' "$staging/repository/package.json")"
version="$package_version"
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

mv "$staging/repository" "$checkout"

launcher_tmp="$launcher.tmp.$$"
cat > "$launcher_tmp" <<'EOF'
#!/bin/sh
set -eu
CODEX_CONNECT_HOME="$(CDPATH= cd "$(dirname "$0")/.." && pwd)"
export CODEX_CONNECT_HOME
exec node "$CODEX_CONNECT_HOME/codex-channels/bin/codexc.mjs" "$@"
EOF
chmod 755 "$launcher_tmp"
mv "$launcher_tmp" "$launcher"
launcher_tmp=""
completed=true

profile_line='export PATH="$HOME/.codex-connect/.bin:$PATH"'
if [ "$install_root" = "$HOME/.codex-connect" ]; then
  case "${SHELL:-}" in
    */zsh) profile="$HOME/.zshrc" ;;
    */bash) profile="$HOME/.bashrc" ;;
    *) profile="$HOME/.profile" ;;
  esac
  if [ ! -f "$profile" ] || ! grep -F "$profile_line" "$profile" >/dev/null 2>&1; then
    printf '\n# Codex Connect\n%s\n' "$profile_line" >> "$profile" \
      || note "无法自动更新 ${profile}；请手工把 $launcher_dir 加入 PATH。"
  fi
fi

rm -rf "$staging"
staging=""
success "Codex Connect Git 源码已安装：$checkout"
printf '%s\n' "分支：main"
printf '%s\n' "命令入口：$launcher"
activation_shell=""
activation_shell_name=""
if [ "$install_root" = "$HOME/.codex-connect" ] && [ -t 1 ]; then
  case "${SHELL:-}" in
    */zsh)
      activation_shell="$SHELL"
      activation_shell_name="Zsh"
      ;;
    */bash)
      activation_shell="$SHELL"
      activation_shell_name="Bash"
      ;;
  esac
fi

if [ -n "$activation_shell" ] && [ -x "$activation_shell" ] \
  && [ -r /dev/tty ] && [ -w /dev/tty ]; then
  printf '%s' "是否立即进入已加载 Codex Connect 的新 ${activation_shell_name}？ [Y/n] " \
    > /dev/tty
  activation_answer="n"
  if IFS= read -r activation_answer < /dev/tty; then
    case "$activation_answer" in
      ""|y|Y|yes|YES)
        PATH="$launcher_dir:$PATH"
        export PATH
        success "源码命令已加载：$launcher"
        print_next_steps
        printf '%s\n' "正在进入新的 ${activation_shell_name}；退出后会返回原终端。"
        exec "$activation_shell" -il < /dev/tty
        ;;
    esac
  fi
fi

if [ "$install_root" = "$HOME/.codex-connect" ]; then
  printf '%s\n' "重新打开终端，或执行：export PATH=\"\$HOME/.codex-connect/.bin:\$PATH\""
else
  printf '%s\n' "请把以下目录加入 PATH：$launcher_dir"
fi
print_next_steps
