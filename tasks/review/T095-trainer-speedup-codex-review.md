# T095 最終レビューレポート

対象: `cff5184..6aedde8`  
変更: `train/src/t090_distillation.rs` のみ、1コミット  
確認: `git diff --check` 成功、`git status --short` は空

## (a) 重大（doneを止めるブロッカー）

なし。

通常の入力・既定構成では、要求された並列化、WTHORキャッシュ、重複計算排除が実装され、数値演算の順序も維持されています。

## (b) 中（次タスクで対応すべき）

1. 壊れたキャッシュの件数フィールドで過大メモリ確保またはpanicが起こり得る

[train/src/t090_distillation.rs:263](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:263) でキャッシュ由来の `u64` 件数をそのまま `usize` に変換し、[同:265](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:265) と [同:273](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:273) で容量確保しています。

件数を改ざん・破損したキャッシュでは、残りバイト数との整合性を確認する前に巨大な容量確保を試みるため、`Err`として再構築経路へ戻らず、capacity overflowやOOMで終了する可能性があります。作業ログの「不正なら再構築」という説明を完全には満たしていません。

件数から必要バイト数をchecked arithmeticで算出し、ファイル残量との一致を確認してから確保してください。キャッシュ本文のビット反転も現在のヘッダ検証では検出できないため、チェックサムの付加も望まれます。

2. 重複するmix/seed指定が並列実行されると同じcheckpoint directoryへ競合書き込みする

[train/src/t090_distillation.rs:1085](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:1085) では指定されたmixとseedをそのまま直積にしており、重複を検査していません。

例えば `--mixes baseline,baseline --seeds 1` では、既定の `jobs=2` により両runが同じ `baseline-seed-1` ディレクトリへ書き込みます。さらに `atomic_write` の一時ファイル名も同一プロセスID由来なので、競合による書き込み失敗やcheckpoint破損が起こり得ます。以前の直列実装では同じ指定でも同時書き込みにはなりませんでした。

重複する `(mix, seed)` をCLI検証で拒否するか、重複排除してから `run_count` とjobsを決定してください。

3. キャッシュを書けない環境では、再構築結果を利用せず学習全体が失敗する

[train/src/t090_distillation.rs:348](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:348) のキャッシュ保存失敗がそのまま `load_outcomes` の失敗になります。そのため、WTHORデータは読み取れるものの `train/data` が書き込み不可という環境では、従来実行できた学習が起動不能になります。

キャッシュは高速化機構なので、保存失敗を警告として扱い、メモリ上に構築済みの `outcomes` とtest集合で学習を続行する設計が妥当です。

## (c) 軽微（記録のみ）

- [train/src/t090_distillation.rs:157](C:/Users/yoshi/work/othello-trainer/train/src/t090_distillation.rs:157) のWTHORファイル読み込みエラーからファイルパス情報が削られています。旧実装同様に `format!("{}: {e}", path.display())` とした方が診断しやすくなります。
- `run_all` 自体の自動テストはありません。ただし作業ログには修正前・修正後直列・修正後並列の全6runについて重みハッシュ一致が記録されており、通常経路の実証としては十分です。
- `train_step` の等価性テストは通常の「相手に合法手あり」局面が中心で、パス・終局分岐は直接網羅していません。ただし実装上は旧分岐と同じ符号・特徴順であり、primary全runの成果物一致でも補完されています。
- キャッシュ初回構築は作業ログ上18.792秒から22.508秒へ遅くなっていますが、2回目は0.692秒まで短縮されており、反復高速化という目的には合致します。

## (d) 総合判定

**合格**

理由:

- 6run並列化はrunごとに独立したモデルを生成し、共有データを読み取り専用参照として渡しているため、既定の一意なmix/seed構成ではデータ競合がありません。
- `--jobs 1` の直列モードと論理コア数・run数を上限とする既定並列度が実装されています。
- run identity、run別checkpoint、epoch単位resumeの形式は変更されていません。
- 親局面の特徴計算と予測計算、およびbest子局面のスコア・勾配特徴が共用され、元実装と同じ特徴順・浮動小数点加算順を維持しています。
- キャッシュは既存WTHORハッシュとスキーマ番号で識別され、固定little-endian形式、重複key・enum・truncation・trailing bytesの検証を備えています。
- 作業ログでは修正前・修正後直列・修正後並列の重み一致、キャッシュ構築/ヒット間の一致、primary成果物およびmetricsの一致、61.4%のwall time短縮が確認されています。
- `cargo test -p train`、`cargo test -p engine`、FFO #40–44の結果も作業ログ上すべて成功しています。今回のレビュー環境はread-onlyのため、ビルド成果物を生成するテストコマンドは再実行していません。
- engineクレートや学習アルゴリズム、ハイパーパラメータ、損失、分割には変更がなく、スコープ外変更もありません。
- 指摘はいずれも通常の既定6runを妨げるものではなく、次タスクで防御性とCLI堅牢性を改善すべき非ブロッカーと判断します。