# T158c 最終コードレビュー(Claude代替レビュー、Codex usage limit中のフォールバック)

- 対象: コミット 5d1dd4d
- 総合判定: **合格**(重大なし、中2件・軽微6件)

## 検証済みの事実

- seed除外の独立再計算: seed1=61段frozen退行3段(+0.229/+0.198/+0.138)、seed3=1段(+0.140)、seed2=0段(最大+0.0122)。判定コードは仕様どおり(+0.10超で除外)。
- Gate 4判定コード(mean悪化<0.2 ∧ agreement低下≥-5pp)・M2/provenanceガード・baseline=v4本番の定義、いずれも設計準拠。
- 多重選択バイアス対策: 選定は害基準のみ(oracle改善を選定に使わない)、unit testで固定。最終ゲートは1候補のみ。manifestにadoptionRule記録。
- smoke: 24局paired・atomic checkpoint/resume・identity guard・fresh-TT二重実行の非決定性検出・非法手検出。12W/1D/11L再計算一致。
- T158d manifest: 設計§8の固定項目(SHA群・opening・Edax実SHA・設定・全スクリーニング結果)完備。
- T158b表示修正は数値メタ不変。

## 中(T158d向け申し送り)

1. **選定seed2はoracle empties19ビンで対v4 +1.727石/局(n=22)の局所退行**(除外seedより大きい)。Gate 4のpass自体は設計準拠だが、小ビンノイズか実退行かの考察がない。**T158dで終盤入口(空き19前後)の対局結果を注視**すること。
2. コミット済みcheckpointのidentityに未コミットビルド成果物(evalCliSha256)を含むため、別環境再実行は必ずfail-loud停止する(静かな誤再利用は構造的に起きない=安全側)。運用注意としてSTATUSに記録。

## 軽微

anomalies配列が構成上常に空(fail-fast設計自体は正)/Gate 4表のv2行delta表示がプレースホルダ/t158b_analyze.pyの死にコード・文字列ハック/stage_triageの空リストmax潜在バグ/manifestのWindowsパス区切り・gitCommitが実行時HEAD/WASMのfeature-off法がnativeと非対称(参考値と明記済み)。
