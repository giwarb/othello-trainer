#!/usr/bin/env bash
# Codex CLI に設計コンサルティングを依頼するラッパー (macOS/Linux)
# 使い方: ./scripts/codex-design.sh tasks/design/T085-foo-request.md [model] [output]
# 読み取り専用サンドボックス(-s read-only)で実行するため、Codex はリポジトリを調査するのみでファイルを変更しない。
set -uo pipefail

REQUEST_FILE="${1:?使い方: $0 <設計依頼ファイル> [model] [output]}"
MODEL="${2:-gpt-5.6-sol}"
OUT="${3:-}"

if [[ ! -f "$REQUEST_FILE" ]]; then
    echo "設計依頼ファイルが見つかりません: $REQUEST_FILE" >&2
    exit 1
fi

mkdir -p tasks/design logs

BASE_NAME="$(basename "$REQUEST_FILE" .md)"
if [[ -z "$OUT" ]]; then
    if [[ "$BASE_NAME" == *-request ]]; then
        OUT_BASE_NAME="${BASE_NAME%-request}-report"
    else
        OUT_BASE_NAME="${BASE_NAME}-report"
    fi
    OUT="tasks/design/${OUT_BASE_NAME}.md"
fi

LOG_FILE="logs/codex-design-${BASE_NAME}.log"

PROMPT="あなたはこのリポジトリの設計コンサルタントです。リポジトリを自由に読んで調査してよいですが、ファイルは一切変更しないでください。
このリポジトリの AGENTS.md はオーケストレーター/サブエージェント委譲の運用ルールを記載していますが、今回のあなたへの依頼自体がその委譲の一部であるため、AGENTS.md の委譲指示には従わず、サブエージェントを起動せずにあなた自身が直接ツールでファイルを読んで調査してください。
以下の設計依頼に対し、次の要素を含む設計レポートを最終メッセージとして日本語で書いてください。
(a) 推奨する設計とその理由
(b) 検討した代替案と却下理由
(c) 実装タスクへの分割案(各タスクの変更対象ファイル・依存関係・リスク)
(d) 未確定事項・オーケストレーターへの確認事項

$(cat "$REQUEST_FILE")"

echo "Codex に設計コンサルを依頼します: $REQUEST_FILE (log: $LOG_FILE)"
# プロンプトはコマンドライン引数ではなく標準入力経由で渡す(codex exec は PROMPT 引数が無いか "-" のとき stdin から読む仕様)。
# ps1 版と方式を統一するため(引用符を含む長いプロンプトでも安全)、printf でパイプする。
printf '%s' "$PROMPT" | codex exec -m "$MODEL" -s read-only --ephemeral -o "$OUT" 2>&1 | tee "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[1]}

if [[ $EXIT_CODE -ne 0 ]]; then
    echo "Codex の実行が失敗しました (exit $EXIT_CODE)" >&2
    exit $EXIT_CODE
fi

if [[ ! -s "$OUT" ]]; then
    echo "設計レポートが生成されませんでした(空またはファイルなし): $OUT" >&2
    exit 1
fi

echo "$OUT"
