---
id: T074
title: 言語化トレーニングモードをナビゲーションから非表示にする
status: todo
assignee: implementer
attempts: 0
---

# T074: 言語化トレーニングモードをナビゲーションから非表示にする

## 目的

ユーザー要望(2026-07-12):「言語化トレーニングはよくわからないからいったんやめることにしてほしい」。ユーザーは完全な削除ではなく、ナビゲーションからの非表示(将来的な復活を想定した一時停止)を望んでいる。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

explorerによる事前調査の結果、言語化トレーニングモード(`verbalize`)への導線は`app/src/app.tsx`内の2箇所のみ:

1. **タイトル画面のモードカード**: `MODE_CARDS`(53〜57行目付近)が`Object.keys(MODE_LABEL)`から生成され、`<TitleScreen cards={MODE_CARDS} .../>`(77行目付近)に渡される。`TitleScreen.tsx`は受け取った`cards`配列をそのまま描画するだけで、モード名のハードコードは無い。
2. **`mode-nav`のタブ**: 95〜105行目付近、`(Object.keys(MODE_LABEL) as AppMode[]).map(...)`でタブボタンを生成しており、この中に`verbalize`が含まれる。

`mode === 'verbalize' && <VerbalizeMode />`(113行目付近)は上記2つの導線が塞がれれば到達不能になるコード分岐であり、これ自体・`VerbalizeMode`コンポーネント本体・関連ファイル(`app/src/verbalize/`配下)は一切削除しない。

## 変更対象

- `app/src/app.tsx` — `MODE_CARDS`生成時とタブ生成時の両方で`verbalize`キーを除外する。

## 要件

1. タイトル画面に「言語化トレーニング」のモードカードが表示されないこと。
2. `mode-nav`のタブに「言語化トレーニング」が表示されないこと。
3. 上記2つの導線を塞ぐのみで、`app/src/verbalize/`配下のコード・`VerbalizeMode`コンポーネント・IndexedDBのスキーマ・データは一切削除・変更しないこと(将来復活させやすいように現状のまま残す)。
4. 万が一URL直打ち等で`verbalize`モードに遷移する経路が残っていても(無ければ気にしなくてよい)、本タスクではそこまでは対応不要(ナビゲーションからの非表示のみが要件)。
5. 既存のテストが壊れないこと(`verbalize`関連の既存テストは、コード自体を削除しないため影響を受けないはずだが、念のため確認する)。

## やらないこと(スコープ外)

- `app/src/verbalize/`配下のファイル・コンポーネント・テストの削除は行わない。
- IndexedDBのスキーマ変更・データ削除は行わない。
- 他モードの変更は行わない。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `npm run dev`で、タイトル画面に「言語化トレーニング」のカードが表示されないこと、`mode-nav`のタブにも表示されないこと、他の6モード中5モード(対局・定石練習・中盤練習・詰めオセロ・棋譜解析)は従来通り表示・利用できることを確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-12 implementer: `app/src/app.tsx` を変更。`MODE_LABEL`のキーから`'verbalize'`を除外した
  `NAV_VISIBLE_MODES`を新設し、`MODE_CARDS`生成(タイトル画面カード)と`mode-nav`タブ生成の両方を
  `Object.keys(MODE_LABEL)`直接参照から`NAV_VISIBLE_MODES`参照に置き換えた。`mode === 'verbalize'
  && <VerbalizeMode />`分岐、`VerbalizeMode`本体、`app/src/verbalize/`配下、IndexedDBスキーマは
  一切変更・削除していない(コメントで意図を明記)。
- 受け入れ基準の実行結果:
  - `npm test`(`app/`配下): 58 test files / 483 tests 全件パス。
  - `npm run build`(`app/`配下): 成功(wasmビルド含め正常終了、`dist/`生成)。
  - 実機確認(ローカル): `npm run preview -- --port 4174`でプレビューサーバーを起動し、
    Playwright(`node`スクリプト、chromium)で`http://localhost:4174/othello-trainer/`を検証。
    タイトル画面のカードは`["対局","定石練習","中盤練習","詰めオセロ","棋譜解析"]`の5件のみで
    「言語化トレーニング」は表示されない。「対局」カードをクリックしてモード画面へ遷移後、
    `mode-nav__tab`は`["対局","定石練習","中盤練習","詰めオセロ","棋譜解析"]`の5件のみで、
    5モードそれぞれのタブが1件ずつ存在し正常にクリック可能であることを確認(コンソール
    エラーなし)。確認後プレビューサーバーは停止済み。
  - 変更を`main`にコミット・push、GitHub Actionsのデプロイ成功確認、本番URL
    (`https://giwarb.github.io/othello-trainer/`)でのPlaywright実機確認は、このメッセージの
    後続でコミット・push・デプロイ待機・本番確認を実施し、結果を追記する(下記追記参照)。
