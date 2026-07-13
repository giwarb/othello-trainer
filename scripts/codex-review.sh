#!/usr/bin/env bash
# Codex CLI に最終レビューを依頼するラッパー (macOS/Linux)
# 使い方: ./scripts/codex-review.sh tasks/T082-foo.md [range] [model] [output]
# 読み取り専用サンドボックス(-s read-only)で実行するため、Codex は git diff / git log 等の読み取りコマンドで差分を調査するのみでファイルを変更しない。
set -uo pipefail

TASK_FILE="${1:?使い方: $0 <タスクファイル> [range] [model] [output]}"
RANGE="${2:-HEAD~1..HEAD}"
MODEL="${3:-gpt-5.6-sol}"
OUT="${4:-}"

if [[ ! -f "$TASK_FILE" ]]; then
    echo "タスクファイルが見つかりません: $TASK_FILE" >&2
    exit 1
fi

if ! git rev-list "$RANGE" > /dev/null 2>&1; then
    echo "Range が不正です: $RANGE" >&2
    exit 1
fi

mkdir -p tasks/review logs

TASK_NAME="$(basename "$TASK_FILE" .md)"
if [[ -z "$OUT" ]]; then
    OUT="tasks/review/${TASK_NAME}-codex-review.md"
fi
LOG_FILE="logs/codex-review-${TASK_NAME}.log"

PROMPT="あなたはこのリポジトリの最終レビュアーです。git diff ${RANGE} と git log ${RANGE} を自分で実行して差分を読み、必要に応じて周辺コードも読んでください。ファイルは一切変更しないでください。
以下のタスク仕様(目的・要件・スコープ外・受け入れ基準)に照らして、次の要素を含むレビューレポートを最終メッセージとして日本語で書いてください。
(a) 重大(done を止めるブロッカー)
(b) 中(次タスクで対応すべき)
(c) 軽微(記録のみ)
(d) 総合判定(合格/不合格とその理由)
正しさ・回帰リスク・設計妥当性・タスク仕様との乖離を重点的に見てください。

$(cat "$TASK_FILE")"

echo "Codex に最終レビューを依頼します: $TASK_FILE (range: $RANGE, log: $LOG_FILE)"
# stdin を /dev/null にして、codex exec が追加入力待ちでハングしないようにする
codex exec -m "$MODEL" -s read-only --ephemeral -o "$OUT" "$PROMPT" < /dev/null 2>&1 | tee "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}

if [[ $EXIT_CODE -ne 0 ]]; then
    echo "Codex の実行が失敗しました (exit $EXIT_CODE)" >&2
    exit $EXIT_CODE
fi

if [[ ! -s "$OUT" ]]; then
    echo "レビューレポートが生成されませんでした(空またはファイルなし): $OUT" >&2
    exit 1
fi

echo "$OUT"
