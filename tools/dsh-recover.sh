#!/bin/bash
# DSH 启动崩溃恢复脚本（Web authentication failed / desktop welcome 报错时使用）。
#
# 机理：DSH 桌面端启动时，主进程会 spawn 一个 dsh-desktop-host 子进程并请求其
# welcome URL 完成鉴权。当某次启动意外崩溃后，host 子进程可能残留（仍持有
# ~/.dsh 下的锁文件与监听端口），导致后续每次启动鉴权都失败，形成
# "崩溃 → 残留进程 → 再崩溃" 的恶性循环。
#
# 用法：DSH 反复崩溃、提示 "desktop welcome: Web authentication failed" 时，
# 先运行本脚本清掉全部残留进程，再正常启动 DeepSeek Harness 即可。
# 本脚本只杀进程，不删除任何数据；任务数据存储在独立位置，不受影响。
set -u

echo "[1/2] 停止所有 DeepSeek Harness 进程（含残留的 host 子进程）…"
pkill -f "DeepSeek Harness" 2>/dev/null
sleep 2
# 二次清理：只杀 host 子进程（主进程若已退出，host 可能仍在）
pkill -f "dsh-desktop-host" 2>/dev/null
sleep 1
pkill -9 -f "dsh-desktop-host" 2>/dev/null

echo "[2/2] 检查残留…"
LEFT=$(pgrep -f "DeepSeek Harness|dsh-desktop-host" 2>/dev/null | wc -l | tr -d ' ')
if [ "$LEFT" = "0" ]; then
  echo "清理完成，无残留进程。现在可以重新启动 DeepSeek Harness。"
  exit 0
else
  echo "仍有 ${LEFT} 个进程残留，可稍候重跑本脚本，或手动检查："
  echo "  pgrep -fl 'DeepSeek Harness|dsh-desktop-host'"
  exit 1
fi
