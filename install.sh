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
command -v codex >/dev/null 2>&1 || fail "缺少 Codex CLI；请先安装并登录配套版本"

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) process.exit(1);
' || fail "Node.js 版本过低；需要 22.13.0 或更高版本"

install_root="${CODEX_CONNECT_HOME:-$HOME/.codex-connect}"
case "$install_root" in
  /*) ;;
  *) fail "CODEX_CONNECT_HOME 必须是绝对路径" ;;
esac
checkout="$install_root/codex-channels"
launcher_dir="$install_root/bin"
launcher="$launcher_dir/codexc"

if [ -e "$checkout" ] || [ -L "$checkout" ]; then
  fail "源码目录已存在：$checkout；已有源码安装请使用 codexc update"
fi
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  fail "命令入口已存在：$launcher；请先确认它是否属于旧安装"
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
codex_version="$(codex --version 2>/dev/null | awk '{ print $NF }')"
codex_version="${codex_version#v}"
[ "$codex_version" = "$version" ] \
  || fail "Codex CLI 版本不匹配：main 需要 $version，当前 ${codex_version:-未知}"

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

profile_line='export PATH="$HOME/.codex-connect/bin:$PATH"'
if [ "$install_root" = "$HOME/.codex-connect" ]; then
  case "${SHELL:-}" in
    */zsh) profile="$HOME/.zshrc" ;;
    */bash) profile="$HOME/.bashrc" ;;
    *) profile="$HOME/.profile" ;;
  esac
  if [ ! -f "$profile" ] || ! grep -F "$profile_line" "$profile" >/dev/null 2>&1; then
    printf '\n# Codex Connect\n%s\n' "$profile_line" >> "$profile" \
      || note "无法自动更新 $profile；请手工把 $launcher_dir 加入 PATH。"
  fi
fi

rm -rf "$staging"
staging=""
success "Codex Connect Git 源码已安装：$checkout"
printf '%s\n' "分支：main"
printf '%s\n' "命令入口：$launcher"
if npm list --global --depth=0 @hegenai/codexc >/dev/null 2>&1; then
  note "检测到已有 npm 全局版；源码入口会优先使用，但 npm 包不会被自动卸载。"
fi
if [ "$install_root" = "$HOME/.codex-connect" ]; then
  printf '%s\n' "重新打开终端，或执行：export PATH=\"\$HOME/.codex-connect/bin:\$PATH\""
else
  printf '%s\n' "请把以下目录加入 PATH：$launcher_dir"
fi
printf '%s\n' "下一步：codexc init && codexc setup && codexc service install"
