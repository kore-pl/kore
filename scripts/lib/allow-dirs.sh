#!/usr/bin/env bash
# allow-dirs.sh — 受控写白名单（KORE_FILE_WRITE_ALLOW_DIRS）的**单一真源**。
#
# 谁在用：scripts/install-root-once.sh、scripts/install-service.sh、
#         scripts/install.sh 三个安装器都 source 本文件。
# 改这里的语义 = 三个安装器**同时**生效；不要在任何安装脚本里重新定义
# resolve_allow_dirs / validate_allow_dirs——重定义会遮蔽本库，又退回
# 「三份副本靠注释对齐」的静默漂移模式（这正是本库要消除的东西）。
#
# 契约（调用方必须保证）:
#   - 定义 ALLOW_DIRS_OVERRIDE：用户显式值（flag/位置参数/环境变量），空 = 用默认。
#   - 定义 FILE_WRITE_ALLOW_DIRS：本库写入的最终值（unit 里那一行）。
#   - 调用 resolve_allow_dirs 时传入安装根（不是 cwd、不是猜的路径）。
#   - 本文件**不** set -e/-u：三个脚本的 set 组合不同，由调用方决定。
#   - 本文件不依赖 cwd；调用方用 BASH_SOURCE 解析自身目录后再 source。
#
# 为什么默认必须注入：受控文件写（file_write）的证书/口令目录前缀白名单**缺省为空 =
# ssl_certificate* / auth_basic_user_file 一律拒绝**（内核不猜安装布局）。不注入的后果
# 不是"少一个可选配置"，而是**装完启用 SSL 的站点全部配置失败**——安装器必须替用户把
# 安装目录内的证书目录写进去。`/etc/nginx/conf.d/` 不在此列：它由协议类别派生
# （pluginapi.FileWritePrefixClasses），重复注入只是冗余，不是必需。

# resolve_allow_dirs 解析最终写进 unit 的白名单：用户显式值优先，否则 <install_root>/data/ssl/。
# 参数就是调用方眼里的"安装根"，本库不关心它来自 --install-root、位置参数还是 --bin 推导。
resolve_allow_dirs() {
  local install_root="${1:-}"
  if [ -n "${ALLOW_DIRS_OVERRIDE:-}" ]; then
    FILE_WRITE_ALLOW_DIRS="$ALLOW_DIRS_OVERRIDE"
  else
    FILE_WRITE_ALLOW_DIRS="$install_root/data/ssl/"
  fi
}

# validate_allow_dirs 在写 unit 前做**最小但必要**的形状校验：写进去的值必须能被内核的
# 注入 helper 接受，否则会出现"unit 看着有注入、实际全被逐条丢弃"的静默 fail-open 假象。
# 规则与 helper 同口径（绝对路径 / 无 .. 段 / 无空白引号反斜杠），另外拒绝空列表——
# 显式清空等于关掉白名单，那是安全边界调整，不该由安装脚本顺手做。
#
# 错误统一走 `[FAIL] ...` + stderr：与三个安装器原来的输出逐字一致（原先两处是
# echo "[FAIL]" >&2、一处是 err()——err() 的实现就是同一条 printf，字节不变）。
validate_allow_dirs() {
  local list="$1" entry
  if [ -z "$list" ]; then
    printf '[FAIL] %s\n' "KORE_FILE_WRITE_ALLOW_DIRS 不能为空（显式清空等于关闭受控写证书白名单）" >&2
    return 1
  fi
  case "$list" in
    *[\"\\[:space:]]*) printf '[FAIL] %s\n' "KORE_FILE_WRITE_ALLOW_DIRS 含空白/引号/反斜杠（unit Environment= 会被截断）: $list" >&2; return 1 ;;
  esac
  # 用 here-doc + tr 切分（不用未引用的 $list 展开）：目录名里的 * ? [ 不该被 shell 当通配
  # 展开成别的路径，否则校验看的是另一组条目。
  while IFS= read -r entry; do
    [ -n "$entry" ] || { printf '[FAIL] %s\n' "KORE_FILE_WRITE_ALLOW_DIRS 含空条目（连续的 : ）: $list" >&2; return 1; }
    case "$entry" in /*) ;; *) printf '[FAIL] %s\n' "KORE_FILE_WRITE_ALLOW_DIRS 条目必须是绝对路径: $entry" >&2; return 1 ;; esac
    case "/$entry/" in */../*) printf '[FAIL] %s\n' "KORE_FILE_WRITE_ALLOW_DIRS 条目不得含 .. 段: $entry" >&2; return 1 ;; esac
  done <<EOF
$(printf '%s' "$list" | tr ':' '\n')
EOF
  return 0
}
