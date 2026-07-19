# T127c 最終コードレビュー(Claude代替レビュー、Codex usage limit中のフォールバック)

- 対象: 33a9352..98060ba(コミット 98060ba)
- 変更ファイル: bench/edax-compare/ の verify_teacher_corpus.py / finalize_teacher_corpus.py / test_teacher_corpus.py / teacher_manifests/README.md / teacher_manifests/corpus_expanded1m.meta.json の5件のみ
- テスト: レビュー時に再実行し49件OK(1.5s)
- 総合判定: **合格**(重大指摘なし)

## 重大(ブロッカー)

なし。

## 中

**中-1: verify checkpointにデータ・ツールのフィンガープリントがなく、resume時の「0エラー」がJSONL改変を検出できない**
`save_verify_checkpoint`/`load_verify_checkpoint` は setName/recordCount/errors/seenCanonical のみで、対象JSONLのSHA・サイズ・mtime、teacher_candidates.exe のSHAを持たない。resume区間ではschema・positionId連番・prefix比較は全件再実施されるが、children値・best/diff・exact/level整合・canonicalKey再計算照合・D4重複・oracle照合はスキップされる。「中断→resume区間を改変→--resume」の経路ではスキーマが保たれた値改変を見逃したまま0エラー完走し得る。
緩和: (a)resumeは明示指定時のみ・既定はフルスキャン (b)checkpoint破損/setName不一致はフルスキャンにフォールバック (c)**T127cの最終0エラー判定はcheckpoint削除後の非resumeフル実行であり、manifestの主張自体は汚染されていない** (d)finalize側がoracle混入とレコード数を独立に全件再集計。
申し送り: checkpointにJSONLサイズ+SHA-256とツールSHAを記録し、不一致ならフルスキャンへ(T143候補)。

**中-2: finalize_expanded1m() に整合性ゲートがなく、矛盾したmanifestも黙って書き出す**
stats["records"]==progress.total、contaminatedRecordsFound==0、thresholdTriggered==False のいずれもassertせず、--verification-result は自由文字列のまま転記。データdrift後にfinalize再実行しても「0エラー検証済み」manifestが書けてしまう。
実害確認: 今回コミットされたmanifest実物は全数値が内部整合しており現成果物に問題なし。運用ガードの欠落のみ(T143候補)。

## 軽微

1. resume区間のストリーミング系エラーが二重計上され得る(水増し方向で実害小)。
2. --progress-every がBATCH_SIZE(500)の倍数でないと進捗・checkpointが一度も発火しない場合がある(バリデーションなし)。
3. manifestのbaseCorpus.path等がWindows区切りのままコミット(verify側は正規化で吸収、他プラットフォーム消費者は各自正規化要)。
4. incrementalGeneration.edaxSha256がv2バイナリのSHAのまま(実際は過半がv3生成。方式境界サイドカーとmeta.edaxExeSha256で説明済み・T143で恒久対応予定だが紛らわしい)。
5. checkpoint破損(不正JSON)→フルスキャンのフォールバックに回帰テストなし。main()のcheckpoint削除は.tmpを掃除しない。
6. 進捗行はstderr出力なのにsys.stdout.flush()(無害)。runKey: nullは生meta継承で許容範囲。

## 重点観点の確認結果(問題なし)

- resume設計: skipは「checkpointが証言する検証済み区間のsubprocess系検証のみ」、prefix/連番/schemaは全件再実施。seenCanonical復元・checkpoint保存境界は正確。
- パス正規化(_normalize_recorded_path): 4フィールド限定・\→/置換のみ。誤ったパスは正規化後も検出される(緩すぎない)。回帰テストは受理・検出の両方向を検証。
- finalize: 既存corpus_stats()の忠実な拡張。サイドカー転記は逐語コピーで忠実(実ファイル突合済み)。candidate nargs変更は後方互換。
- manifest整合: sourceCounts 999,935+65=1,000,000 / phase・year・opening・XC・ヒストグラム・SHA群の全クロスチェック合格 / 方式境界2件転記済み。
- テスト実効性: resumeテストは実subprocessカウントで直接検証、finalizeテストは手計算期待値で自己参照なし。
- スコープ: 5ファイルのみ。gen_teacher_corpus.py・データ本体・シャード未変更。
