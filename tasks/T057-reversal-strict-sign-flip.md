---
id: T057
title: 「逆転」判定を厳密な符号反転(+から-、またはその逆)のみに限定する
status: todo
assignee: implementer
attempts: 0
---

# T057: 「逆転」判定を厳密な符号反転(+から-、またはその逆)のみに限定する

## 目的

T056(累積ロス方式の評価値モデル)で、「逆転」判定を`Math.sign(before) !== Math.sign(after)`という単純な符号比較で実装した。この方式では、累積評価値の起点`E[0]=0`(互角)から最初に非0の値へ動いた場合、そのロスの大小に関わらず必ず「逆転」表示になってしまう(0と非0は常に異なる符号として扱われるため)。ユーザー確認の結果、これは意図と異なるため、「符号が厳密に+から-(またはその逆)に転じた場合のみ」を逆転とするよう修正する。

## 背景・コンテキスト

- `app/src/analysis/analyzeGame.ts`の`applyCumulativeEvaluation`関数内、`reversal`の計算式(T056作業ログに記載: `Math.sign(before) !== Math.sign(after)`)を、`(before > 0 && after < 0) || (before < 0 && after > 0)`(0を特別扱いしない、厳密な符号反転のみ)に差し替える。
- T056のimplementer自身がこの代替式を作業ログ(`tasks/T056-cumulative-eval-model.md`の「設計判断の記録」節)に明記済みであり、1行の差し替えで対応可能とされている。

## 変更対象

- `app/src/analysis/analyzeGame.ts`の`applyCumulativeEvaluation`内、`reversal`計算式。
- `app/src/analysis/analyzeGame.test.ts`の既存テスト(「1手だけの棋譜を解析」テスト等、`reversal: true`を期待している箇所のうち、`E[0]=0`からの最初の非0遷移によるものがあれば、期待値を修正)。T056で追加された「逆転」判定の新規テストも、新しい判定基準に合わせて期待値を確認・更新する。

## 要件

1. 累積評価値が`0`から非0の値へ変化しただけでは「逆転」と判定されないこと(例: `0 → -1`は逆転ではない)。
2. 累積評価値が厳密に正から負へ、または負から正へ転じた場合のみ「逆転」と判定されること(例: `+5 → -3`は逆転、`-5 → -3`は逆転ではない)。
3. 既存のテストが壊れないこと(挙動変更に伴う期待値の更新は行ってよい)。
4. `npm test`が全件パスすること。

## やらないこと(スコープ外)

- 累積評価値の漸化式自体(E[0]=0、ロスの加減算)は変更しない(T056の実装のまま)。
- 他の悪手判定・分類ロジックは変更しない。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: 棋譜解析モードで、定石を外れた直後の最初の手が悪手(かつ評価値が0から非0へ動くだけで符号は反転しない程度のロス)の場合に「逆転」表示が付かないこと、実際に符号が反転する悪手では引き続き「逆転」表示が付くことを`npm run dev`で確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

- 2026-07-11 implementer: `app/src/analysis/analyzeGame.ts`の`applyCumulativeEvaluation`内、`reversal`計算式を`Math.sign(before) !== Math.sign(after)`から`(before > 0 && after < 0) || (before < 0 && after > 0)`(0を特別扱いしない厳密な符号反転のみ)に変更。直前のJSDocコメントもこの挙動に合わせて更新。
- `app/src/analysis/analyzeGame.test.ts`を更新:
  - 「1手だけの棋譜を解析し、ロス・分類・逆転を正しく計算する」テスト: `E[0]=0→E[1]=-3.5`は0からの遷移のため`reversal`期待値を`true`→`false`に修正。
  - T038「定石DBがnullなら定石照会をスキップし、従来通り評価する(要件3)」テスト: 同様に`0→-3.5`の遷移につき`reversal`期待値を`true`→`false`に修正。
  - T056「逆転判定は累積評価値の符号が実際に変わった場合にのみ発生する」テストを、実際に厳密な符号反転(+から-、-から+)が起きる4手構成のシナリオ(0→0→+5→-3→-1)に全面的に作り直し、`0→非0`(逆転でない)・`+5→-3`(逆転)・`-3→-1`(逆転でない、負のまま)の3パターンを1テストで検証するように変更(タスク仕様の設計判断の記録にある代替式と例をそのまま採用)。
  - `npm test`(`app/`配下): 54ファイル・456件全件パス。
  - `npm run build`(`app/`配下): 成功(`tsc -b && vite build`まで完走)。
- 実機確認(`npm run dev`、localhost:5173): Playwrightスクリプト(scratchpad、コミット対象外)で「棋譜解析」モードに、辞書順先頭の合法手を選び続ける決定的方策で生成した実在合法な20手棋譜(`c4c3c2b2a2a1d3a3b3b4a4a5b1c1e6b5a6a7b6`)を投入し解析。EvalGraphの各ポイントtitle(`N手目時点: ±X石`)から累積評価値の推移を取得し、ムーブリスト行の`--reversal`クラス付与が全19手にわたり`(before>0 && after<0) || (before<0 && after>0)`の期待値と完全一致することを確認(`ply=3: before=0 after=-25 reversal=false`など、0からの遷移は逆転扱いされないことを含め全件OK)。console errorなし。
- 変更をmainにコミット・push予定。push後、GitHub Actionsのデプロイ成功を確認し、同じPlaywrightスクリプトを本番URL(`https://giwarb.github.io/othello-trainer/`)に対して実行し実機確認する(以降のログに追記)。
