#!/usr/bin/env bash
# 一键构建脚本（Git Bash 用）
#
# 用法：
#   ./build.sh          只重新生成 index.html（本地预览）
#   ./build.sh push     生成 + 提交 + 推送到 GitHub（SSH，自动部署 Pages）
#   ./build.sh pushall  生成 + 提交 + 推送到 GitHub + Gitee
#
# 前提：已配好 GitHub SSH key 和 Gitee origin
cd "$(dirname "$0")" || exit 1
node build.js "$1"
