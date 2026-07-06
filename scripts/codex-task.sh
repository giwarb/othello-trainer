#!/usr/bin/env bash
# Codex CLI にタスク仕様ファイルを渡して非対話実行するラッパー (macOS/Linux)
# 使い方: ./scripts/codex-task.sh tasks/T001-add-login.md [model]
set -euo pipefail

TASK_FILE="${1:?使い方: $0 <タスクファイル> [model]}"
MODEL="${2:-}"

if [[ ! -f "$TASK_FILE" ]]; then
    echo "タスクファイルが見つかりません: $TASK_FILE" >&2
    exit 1
fi

TASK_NAME="$(basename "$TASK_FILE" .md)"
mkdir -p logs
LOG_FILE="logs/codex-${TASK_NAME}.log"

PROMPT="以下のタスク仕様に従って作業してください。「やらないこと(スコープ外)」を厳守し、
完了前に「受け入れ基準」のコマンドを実行して確認すること。
完了後、タスクファイル (${TASK_FILE}) 末尾の「作業ログ」に実施内容を追記すること。

$(cat "$TASK_FILE")"

ARGS=(exec --full-auto)
[[ -n "$MODEL" ]] && ARGS+=(-m "$MODEL")

echo "Codex にタスクを委譲します: $TASK_FILE (log: $LOG_FILE)"
codex "${ARGS[@]}" "$PROMPT" 2>&1 | tee "$LOG_FILE"
