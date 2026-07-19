---
id: T147
title: v4重みの本番アプリ組み込み(ユーザー裁定による採用)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)(Codex usage limit中のフォールバック)
attempts: 0
---

# T147: v4本番配線

## 目的(ユーザー裁定 2026-07-20)

「いったん(教師データ)強化をやめ、v4を本番アプリに組み込む方を先にやる」— 評価関数の本番重みを v3×WTHOR から **v4×WTHOR(ステージ1石刻み61段、oracle regret歴代最良)** に切り替える。

**経緯の明示(重要)**: v4はT125の最終審査で「oracle最良(0.967〜1.111)だが対Edax60局はv3比-2.78石(有意差なし・CI跨ぎ)」により一旦見送りとなった候補。今回は**この経緯を承知のうえでのユーザー裁定による採用**である。本タスクは配線の正しさの検証に集中し、**強度の再審査(60局ゲート)は行わない**。

## 使用する重み

- **T125で事前登録規準により選定された v4×WTHOR seed3 の重み**(oracle regret 0.967)。所在とSHA-256は `tasks/T125-v4-adjudication.md` の作業ログおよび対応するmeta(bench/edax-compare/ の t125系 meta json)を参照して特定すること。重み実体はgitignore領域(train/data/ 配下)にあるはずで、見つからない場合は T124/T125 の学習構成で同一seedを再現学習してSHA一致を確認する(T124metaに構成記録あり)。
- 重みファイルの配信形式・配置は v3 の前例(T122、`tasks/T122-v3-production-wiring.md`)に完全に倣う: app配信用に `pattern_v4.bin` として追加(gzip配信+3.4MB、ロード+31msはT124で計測済み)。

## 要件(T122の前例に倣う)

1. **エンジン側**: v4パターンセット(61段ステージ)の重みロードが本番WASM経路で動くこと(T124でエンジン側実装・NPS 100.9%確認済みのはず。未対応箇所があれば追従)。
2. **app側配線**: `app/src/engine/worker.ts` の重みfetchを pattern_v4.bin に切り替え(v3への切り戻しを1行+コメントで残す。**切り戻しコメントにはANALYSIS_ENGINE_VERSION繰り上げ必須の注意を含める**=T122/T139前例)。
3. **ANALYSIS_ENGINE_VERSION を 5→6**(app/src/analysis/cache.ts。評価値が変わるため必須)。
4. **Service Worker キャッシュ整合**: 重みファイルの追加・キャッシュマニフェスト更新(T122前例)。
5. **スモーク確認(強度審査ではない)**: ローカルで対局・中盤練習・詰めオセロ・棋譜解析・評価バーが正常動作。加えて対Edaxの軽いスモーク(レベル10、10局程度)で異常(クラッシュ・move:null・途中終了・全敗超えの崩壊)がないことを確認(結果の勝敗自体はゲートにしない)。
6. **Pages実機確認**: mainへpush→GitHub Actionsデプロイ成功→本番URL(https://giwarb.github.io/othello-trainer/)で pattern_v4.bin の取得200・対局/解析/評価バー動作をPlaywright等で確認。

## スコープ外

- 強度の再審査(60局paired対局ゲート)・oracle再計測
- v4以外の重み学習・教師データ生成
- 探索系の変更

## 受け入れ基準

1. 本番Pagesで v4 重みが配信・ロードされ、対局/中盤練習/詰めオセロ/棋譜解析/評価バーが動作(実機確認の記録)
2. ANALYSIS_ENGINE_VERSION=6、SWキャッシュ整合、v3切り戻し手順がコメントで残っている
3. 使用した重みのSHA-256がT125選定候補と一致することの確認記録(または再現学習での一致確認)
4. エンジン・appの既存テスト(`cargo test -p engine --lib`、`npx vitest run`)全パス
5. 対Edaxスモーク10局で異常なし(異常時は報告して停止、勝敗はゲートでない)
6. 変更ファイルはパス明示でコミットしmainへpush、完了時 `git status --short` クリーン

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)
- コミットメッセージに「ユーザー裁定による採用(T125経緯承知の上)」の旨を含める

## 作業ログ

(ワーカーが節目ごとに追記)
