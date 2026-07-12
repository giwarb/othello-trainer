---
id: T071
title: UI磨き込み(8): アイコン/マニフェストの作り込み
status: done
assignee: implementer
attempts: 0
---

# T071: UI磨き込み(8): アイコン/マニフェストの作り込み

## 目的

UI/UX監査で洗い出した優先度順8項目のうち、(1)〜(7)(盤面サイズ統一・デザイントークン一元化・タイトル/ホーム画面・石の反転アニメーション・勝敗演出のリッチ化・ボタン等のホバー/クリックフィードバック・アクセントカラー統一)がすべて完了済み。本タスクは**最後(8番目)の項目**「アイコン/マニフェストの作り込み」を実装する。現状のPWAアイコンはT014導入時から「プレースホルダー」のまま作り込まれておらず、いくつかの技術的な不備(iOS非対応・maskable未対応)も残っている。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

explorerによる事前調査の結果:

- `app/public/manifest.json`: name「オセロトレーナー」、`theme_color: "#863bff"`(T061の`--color-accent`トークンと一致)、`icons`配列はSVG2件(`icon-192.svg`, `icon-512.svg`)のみで、いずれも`purpose: "any"`。
- `app/public/icons/icon-192.svg`・`icon-512.svg`は、角丸正方形(紫背景)+黒丸+白破線+白丸というごく単純な図形で、T014のタスク仕様書自体に「凝ったデザインは不要、詳細なアプリアイコンのデザインはスコープ外」と明記された**意図的なプレースホルダー**。
- `app/index.html`の`<link rel="apple-touch-icon" href="/icons/icon-192.svg">`が**SVGのまま**指定されている。iOS Safariは`apple-touch-icon`のSVG形式を正式サポートしておらず、ホーム画面に追加した際に汎用アイコンやページの見た目からの自動生成にフォールバックする可能性が高い(T014完了時からの既知の未解決課題、`tasks/STATUS.md`に記録あり)。**PNG形式のapple-touch-iconを別途用意する必要がある。**
- `manifest.json`の`icons`に`purpose: "maskable"`(Android等のアダプティブアイコンで、丸型・角丸型に自動トリミングされる際に中心の安全領域(セーフゾーン、通常は中心80%程度の円内)に主要な図柄を収める必要がある形式)の指定が無い。現状のアイコン(黒丸・白丸が画面いっぱいに配置)は、そのままmaskableとして扱われると重要な図柄が切り取られる可能性が高い。
- `app/public/favicon.svg`はアプリアイコンとは別の、グラデーション・ぼかしフィルタを多用した複雑な多層SVGで、色調も`#7e14ff`等アイコンや`--color-accent`トークンと微妙に異なる複数の紫トーンを使っており、**視覚的に統一されていない**。
- `screenshots`・`shortcuts`・`categories`等のマニフェスト任意フィールドは未使用(本タスクでの追加は必須ではない、要件参照)。
- リポジトリには画像編集ツールは無いが、Playwright(Chromiumヘッドレスブラウザ)は既に開発・検証で使われており、SVGをレンダリングしてPNGスクリーンショットとして書き出す用途に転用できる(実際にT062〜T070の各タスクでPlaywrightによる実機確認に使われてきた実績がある)。

## 変更対象

- `app/public/icons/icon-192.svg` / `icon-512.svg` — オセロらしさが伝わる、もう少し作り込まれたデザインに刷新する(過度に複雑にする必要はない。シンプルながら現状より意匠性のあるデザインでよい)。`--color-accent`(`#863bff`)を基調にする。
- `manifest.json`の`icons`配列 — 新規デザインの`purpose: "any"`アイコンに加え、セーフゾーンを考慮した`purpose: "maskable"`のアイコン(バリアントを追加、または既存デザインをセーフゾーン内に収まるよう余白を持たせて両対応にする)を追加する。
- 新規のPNG形式apple-touch-icon(180x180が標準的なサイズ)を生成し、`app/index.html`の`<link rel="apple-touch-icon">`をこのPNGを指すように変更する。生成方法は実装判断でよい(例: PlaywrightでSVGをレンダリングしスクリーンショットとしてPNGを書き出す一時スクリプトを作り、生成物のみを`app/public/`にコミットする)。
- `app/public/favicon.svg` — アプリアイコンと視覚的に一貫したデザイン・配色(`--color-accent`系のみ使用)に簡略化・統一する。

## 要件

1. アプリアイコン(`icon-192.svg`/`icon-512.svg`)が、現状のプレースホルダーよりも意匠性のあるデザインになっていること(オセロを想起させるモチーフを保ちつつ、単純な図形の羅列以上の作り込みがあること)。
2. `manifest.json`に`purpose: "maskable"`に対応したアイコン(セーフゾーンを考慮した余白があるもの)が追加されていること。
3. `app/index.html`の`apple-touch-icon`が実際のPNG形式のファイルを指しており、SVGではないこと。
4. `favicon.svg`がアプリアイコンと視覚的に統一感のある配色・デザインになっていること。
5. アイコンの配色は`app/src/index.css`の`--color-accent`(`#863bff`)を基調とし、無関係な新規トーンを追加しないこと。
6. 既存のPWA動作(オフライン起動、ホーム画面への追加)に回帰が無いこと。
7. 既存のテストが壊れないこと。

## やらないこと(スコープ外)

- `screenshots`・`shortcuts`・`categories`等のマニフェスト任意フィールドの追加は行わない(要望されていない)。
- アイコン以外のPWA設定(Service Worker、Cache戦略等)の変更は行わない。
- 外部の画像生成AI・デザインツールへの依存追加は行わない(SVGの手書き・Playwrightレンダリング等、リポジトリ内で完結する手段で対応する)。
- ロゴ・ブランディングの大規模な作り直し(アプリ名変更等)は行わない。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `npm run dev`で、`manifest.json`が正しく取得できブラウザの開発者ツール(またはPlaywright経由の`fetch`)でicons配列が意図通り(any/maskable両方)であることを確認する。`apple-touch-icon`のリンク先が実際に有効なPNGファイル(バイナリのcontent-typeやマジックナンバー確認等)であることを確認する。新しいアイコンSVG・favicon.svgが実際にブラウザで意図通り描画されること(スクリーンショットで視覚的に確認する)。maskableアイコンについては、中心の安全領域(円形マスク相当)内に主要な図柄が収まっているか、SVGの座標・余白から確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

### 2026-07-11 implementer

**実施内容**

- `app/public/icons/icon-192.svg` / `icon-512.svg`(既存を刷新、`purpose: "any"`用): 角丸正方形の背景を `--color-accent`(#863bff)〜`--color-accent-dark`(#6d2fd1)の対角グラデーションにし、中央にダーク盤面(4x4グリッド線入り)+クラシックなオセロ開局配置(白2枚・黒2枚を対角に配置、`radialGradient`でわずかな光沢)を描画。単純な「黒丸+白破線+白丸」から、盤面と石を想起させるデザインに変更。
- `app/public/icons/icon-192-maskable.svg` / `icon-512-maskable.svg`(新規、`purpose: "maskable"`用): 背景を角丸なしで全面に塗り、盤面+石のモチーフを中心80%セーフゾーン(半径=一辺の40%)内に収まるサイズ・位置で配置(盤面の対角コーナーまでの距離が安全半径以下になるよう計算)。
- `app/public/manifest.json`: `icons`配列に上記2件のmaskableバリアント(`sizes`は同じ192x192/512x512、`purpose: "maskable"`)を追加。既存の`any`エントリはそのまま維持。
- `app/public/icons/apple-touch-icon.png`(新規生成): Playwrightで`icon-192-maskable.svg`のマークアップをHTMLに直接インライン埋め込みしてレンダリングし、180x180のPNGとしてスクリーンショット書き出し。生成に使った一時スクリプトはスクラッチパッド配下のみに置き、コミット対象は生成物のPNGのみ。
  - 補足(ハマった点): 当初は`<img src="file:///...">`でSVGファイルを外部参照する方式で生成したところ、Chromiumの`file://`サブリソースアクセス制限により画像が「壊れた画像」アイコンのまま静かにロード失敗し(`naturalWidth`はなぜか非0を報告し気づきにくい)、その状態のスクリーンショットを保存してしまっていた。SVGファイルの中身をJSで読み込みHTML内に直接インライン埋め込みする方式に変更して解決。生成後、Node/PythonでPNGバイナリの実ピクセル値をサンプリングして紫グラデーション・盤面が実際に描画されていることを確認済み。
- `app/index.html`: `<link rel="apple-touch-icon">`を`href="/icons/icon-192.svg"`から`href="/icons/apple-touch-icon.png"` `sizes="180x180"`に変更。
- `app/public/favicon.svg`: グラデーション・ぼかしフィルタを多用した複雑な多層SVG(`#7e14ff`等、アイコンと異なる紫トーンを使用)から、アプリアイコンと同一の配色(`--color-accent`〜`--color-accent-dark`グラデーション)・同一モチーフ(盤面+対角4石)のシンプルな48x48 SVGに全面刷新。viewBoxも従来の`0 0 48 46`(半端な高さ)から`0 0 48 48`の正方形に統一。

**受け入れ基準の実行結果**

- `npm test`(`app/`配下): 57 test files / 477 tests 全件パス。
- `npm run build`(`app/`配下): 成功(`tsc -b && vite build && inject-sw-version`まで完走、`dist/`生成確認)。
- 実機確認(`npm run dev` on port 5183 + Playwright):
  - `manifest.json`をfetchし`icons`配列を確認: `any`(192/512)2件+`maskable`(192/512)2件の計4件が期待通り含まれることを確認(`hasAny192/hasAny512/hasMaskable192/hasMaskable512`すべて`true`)。
  - `apple-touch-icon`リンク先(`/icons/apple-touch-icon.png`)を`page.request.get`で取得し、`content-type: image/png`・マジックナンバー`89504e470d0a1a0a`(PNGシグネチャ)であることを確認。さらに実ページの`<img>`要素で`decode()`後に`naturalWidth/naturalHeight`が180x180になること、スクリーンショットで実際に紫背景+盤面+石が描画されていることを目視確認(Node/PythonでのPNGピクセルサンプリングでも同様に確認)。
  - 新しい`icon-192.svg`/`icon-512.svg`/`icon-192-maskable.svg`/`icon-512-maskable.svg`/`favicon.svg`をブラウザで`<img>`表示しスクリーンショットで意図通りの見た目(紫グラデーション背景+ダーク盤面+白黒4石)を視覚確認。
  - maskableのセーフゾーン確認: `icon-192-maskable.svg`を`border-radius:50%; overflow:hidden`の192x192円形コンテナ内に表示しスクリーンショットを撮影、盤面・石が円形マスクの内側に余裕を持って収まり切り取られていないことを確認。
- 本番デプロイ確認: 下記参照。

**本番デプロイ・実機確認**

- `git add app/index.html app/public/favicon.svg app/public/icons/icon-192.svg app/public/icons/icon-512.svg app/public/icons/icon-192-maskable.svg app/public/icons/icon-512-maskable.svg app/public/icons/apple-touch-icon.png app/public/manifest.json` の範囲でコミットし、mainにpush。
- `gh run watch`でGitHub Actionsのデプロイワークフローの成功を確認。
- Playwrightで本番URL(`https://giwarb.github.io/othello-trainer/`)に対し、開発環境と同一のチェック(manifest.iconsのany/maskable4件、apple-touch-iconのPNG検証、各アイコン・faviconの視覚確認、maskableセーフゾーン確認)を実施し、いずれも同様に成功したことを確認。

(コマンド出力の詳細はセッションログ参照。要点は上記の通りすべて成功。)
