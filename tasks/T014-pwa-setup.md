---
id: T014
title: PWA設定(manifest + Service Worker + オフライン対応)
status: done
assignee: implementer
attempts: 0
---

# T014: PWA設定(manifest + Service Worker + オフライン対応)

## 目的
アプリをPWA(インストール可能・オフラインで動作)にする。設計書のPWA要件(§2.11)のうち、現時点(シングルスレッドエンジン、対局モードのみ)で必要な範囲を実装する。

## 背景・コンテキスト
- 前提: T013(対局モード)完了済み。
- 設計書 §2.11「PWA / GitHub Pages配信設計」を参照。ただし**現時点のエンジンはシングルスレッド**(Lazy SMP・マルチスレッド化はフェーズ7のスコープであり未実装)なので、**coi-serviceworker によるCOOP/COEPヘッダ注入(SharedArrayBuffer有効化)は本タスクでは不要**(スコープ外とする。マルチスレッド化する時が来たら別タスクで対応する)。
- 素のService Worker(Workbox不使用、設計書の方針通り)でアプリ本体(HTML/JS/CSS/WASM)をキャッシュし、オフラインで対局モードが動作するようにする。

## 変更対象(新規作成)
- `app/public/manifest.json`(PWA manifest: アプリ名、アイコン、`display: standalone`、テーマカラー等)
- `app/public/icons/`(簡単なプレースホルダーアイコン。凝ったデザインは不要、単色背景+文字程度でよい。SVGでも可)
- `app/src/sw.ts`(または `app/public/sw.js`): Service Worker本体。ビルド成果物(HTML/JS/CSS/WASM)をcache-first戦略でキャッシュする
- `app/src/registerServiceWorker.ts`: アプリ起動時にService Workerを登録するコード
- `app/index.html`: `<link rel="manifest">` タグ、iOS用メタタグ(`apple-mobile-web-app-capable` 等)を追加

## 要件
1. `manifest.json` に `name`, `short_name`, `start_url`, `display: "standalone"`, `background_color`, `theme_color`, `icons`(最低192x192と512x512の2サイズ)を設定する。`start_url` はGitHub Pagesのサブパス(`/othello-trainer/`)を考慮した相対パスにする(T010で設定した `base` と整合させる)。
2. Service Worker: `install` イベントでアプリシェル(ビルド後の `dist/` 配下の主要ファイル)をプリキャッシュし、`fetch` イベントでcache-first(キャッシュにあればキャッシュから返し、無ければネットワーク→キャッシュに追加)で応答する。バージョン管理のため、キャッシュ名にビルド時のバージョン文字列(例: `package.json` の `version` またはビルド日時)を含め、新しいバージョンがアクティブになったら古いキャッシュを削除する(`activate` イベントで `caches.keys()` を確認し、現在のバージョン名以外を削除)。
3. WASMファイル(`engine_bg.wasm`)もキャッシュ対象に含める(初回ロード後はオフラインでエンジンが動作するように)。
4. `registerServiceWorker.ts` をアプリのエントリポイント(`main.tsx`)から呼び出し、`navigator.serviceWorker` が使える環境でのみ登録する(フィーチャー検出。使えない環境でエラーにならないようにする)。
5. 動作確認: `npm run build && npm run preview` でビルド済みアプリを起動し、ブラウザの開発者ツール(Application タブ等)でService Workerが登録され、Cache Storageにファイルがキャッシュされていることを確認する。可能であれば、ネットワークを切断した状態でページをリロードしても対局モードが動作することを確認する。確認結果を作業ログに記載すること。

## やらないこと(スコープ外)
- coi-serviceworker によるCOOP/COEPヘッダ注入・SharedArrayBuffer対応(マルチスレッド化する将来のタスクで対応)
- `navigator.storage.persist()` の呼び出し(将来のタスクで良い。設計書に記載はあるが優先度低)
- 詳細なアプリアイコンのデザイン(プレースホルダーで良い)
- バージョン更新通知UI(「更新があります」トースト等。設計書§2.11.2にあるが本タスクでは省略可。単純にactivate時に古いキャッシュを削除するのみでよい)

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm run build` が成功する
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] 作業ログに、Service Worker登録・Cache Storageへのキャッシュ・(可能であれば)オフライン動作の確認結果が記載されている

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

2026-07-07 implementer:

### 実装内容
- `app/public/manifest.json`: name/short_name/description/start_url(`"."`)/scope(`"."`)/display(`standalone`)/background_color/theme_color/icons(192x192, 512x512のSVG)を設定。`start_url`/`scope`/`icons.src`はすべて相対パスとし、manifest.json自身のURL(`<base>/manifest.json`)からの相対解決でGitHub Pagesのサブパス(`/othello-trainer/`)にも開発サーバー(`/`)にも両対応させた。
- `app/public/icons/icon-192.svg`, `icon-512.svg`: プレースホルダーアイコン(紫背景+オセロの石を模した円のシンプルなSVG)。
- `app/public/sw.js`(素のJS、Workbox不使用。`public/`配下なのでVite/GitHub Pagesの`base`配下にそのままコピーされる):
  - `install`: 固定パスのシェル(`./`, `manifest.json`, `favicon.svg`, アイコン)に加え、`./`(index.html)をfetchしてHTML中の`<script src>`/`<link href>`からハッシュ付きJS/CSS(`assets/index-*.js`等)のURLを動的に発見してプリキャッシュする(ビルドごとにファイル名がハッシュ化されるため、静的な列挙ではなく実行時発見方式を採用)。
  - `fetch`: 同一オリジンGETのみをcache-first戦略で処理(キャッシュ命中ならそれを返し、無ければネットワーク取得後キャッシュに追加)。WASM(`engine_bg-*.wasm`)やWorkerチャンク(`worker-*.js`)は index.html 経由では発見できないため、実際にリクエストされた時点(初回のCPU対局時)でこのfetchハンドラ経由でキャッシュされる。オフラインでキャッシュも無いnavigateリクエストには`./`のキャッシュをフォールバックとして返す。
  - `activate`: `caches.keys()`を見て現在の`CACHE_NAME`(`othello-trainer-v${CACHE_VERSION}`。`CACHE_VERSION`は`package.json`の`version`と合わせた文字列。リリースごとに手動更新する運用)以外を削除。
- `app/src/registerServiceWorker.ts`: フィーチャー検出(`'serviceWorker' in navigator`)に加え、`import.meta.env.PROD`が真の場合のみ登録するようにした(devサーバーでのHMRとSWのcache-first戦略が相性が悪いため、開発体験を壊さない目的で追加。要件4には反しない)。`window`の`load`イベント後に`${import.meta.env.BASE_URL}sw.js`を登録。
- `app/src/main.tsx`: `registerServiceWorker()`をエントリポイントから呼び出すよう追加。
- `app/index.html`: `<link rel="manifest" href="/manifest.json">`、`theme-color`、iOS用meta(`apple-mobile-web-app-capable`等)、`apple-touch-icon`を追加。

### スコープ外だが修正した既存の不具合(要事前確認)
検証(`npm run build && npm run preview`)の過程で、**T010由来の`app/vite.config.ts`の既存バグ**を発見し、あわせて修正した(タスクの「変更対象」外だが、これが無いと本タスクの受け入れ基準にある`npm run preview`でのオフライン動作確認自体が実施不可能だったため修正した):
- 症状: `base: command === 'build' ? '/othello-trainer/' : '/'` の判定は、`vite preview`実行時も`command`が`'build'`ではなく`'serve'`になるため`base`が`/`に戻ってしまい、ビルド済み`dist/index.html`に焼き込まれた`/othello-trainer/...`参照と配信パスが食い違い、`/othello-trainer/`配下への全リクエストがSPAフォールバック(index.htmlの200応答)になっていた(JS/CSS/manifest/sw.js等、実質すべてのアセットが正しく配信されない状態)。
- 修正: `defineConfig(({ command, isPreview }) => ({ base: command === 'build' || isPreview ? '/othello-trainer/' : '/', ... }))` とし、`vite preview`時(`isPreview === true`)にも本番同様のbaseを適用するようにした。
- 影響範囲: PWA機能自体とは無関係だが、`npm run preview`によるビルド成果物の動作確認全般(既存のT010〜T013の確認や今後のリリース前確認)に影響する既存バグだった。

### 検証結果
- `cd app && npm run typecheck` → エラー0で成功。
- `cd app && npm run build` → 成功(`dist/manifest.json`, `dist/sw.js`, `dist/icons/*.svg`が正しく`/othello-trainer/`ベースで出力されることを確認)。
- `cd app && npm test` → 4ファイル/33件全てパス(既存テストに影響なし)。
- `npm run preview`(ポート4175)+ Playwright(システムにインストール済みのChromeを`channel: 'chrome'`で使用、`playwright`パッケージはリポジトリ外のスクラッチディレクトリに一時インストールしapp/package.jsonには追加していない)でヘッドレスブラウザから実機同等の確認を実施:
  - Service Worker登録: `navigator.serviceWorker.getRegistration()`で`activeState: "activated"`、`scriptURL: ".../othello-trainer/sw.js"`、リロード後`controller: true`を確認。
  - Cache Storage: `caches.keys()`で`othello-trainer-v0.0.0`という1つのキャッシュが存在し、`cache.keys()`で以下がキャッシュ済みであることを確認: `manifest.json`, `/`(index.html), `favicon.svg`, `icons/icon-192.svg`, `icons/icon-512.svg`, `assets/index-*.js`, `assets/index-*.css`。オンラインで一度CPU対局(1手)を行った後は`assets/worker-*.js`と`assets/engine_bg-*.wasm`もキャッシュに追加されることを確認。
  - オフライン動作確認(`context.setOffline(true)`でネットワーク切断): ページリロードでタイトル・盤面(canvas)が正しく表示されることを確認。さらにオフラインのまま黒番の初手をクリック→スコアが変化→CPU(Worker経由のWASMエンジン)が応答して黒番に手番が戻ることまで確認し、オフラインでも対局モードが最初から最後まで(人間の着手・CPUの着手とも)正常に動作することを実証した。
  - 検証中に見つけた不具合と修正: (1) 上記vite.config.tsのbase不具合、(2) `sw.js`の`caches.match()`で`{ ignoreVary: true }`を指定していなかったため、配信サーバー(sirvベースの`vite preview`)が付与する`Vary: Origin`ヘッダにより、`<script crossorigin>`/`<link crossorigin>`経由のJS/CSSリクエスト(Originヘッダ付き)とinstall時のキャッシュ(Originヘッダ無し)でVary判定が食い違い、オフライン時にJS/CSSがキャッシュヒットせず読み込めなくなる不具合があったため、`caches.match(request, { ignoreVary: true })`に修正して解消した。

### 実施しなかったこと(スコープ外の確認)
- 実ブラウザのGUIでのDevTools目視確認(Application タブでのアイコン表示等)は未実施。上記の通りPlaywrightで`navigator.serviceWorker`/`caches` APIを直接呼び出して同等の内容を機械的に確認した。
- GitHub Pages実配信環境での確認は未実施(ローカルの`vite preview`のみ)。
