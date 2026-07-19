# T143 最終コードレビュー(Claude代替レビュー、Codex usage limit中のフォールバック)

- 対象: コミット 51d25d4(範囲 4a0f8f7..51d25d4、bench/edax-compare/ 5ファイル)
- 総合判定: **合格**(ブロッカーなし、中2件・軽微5件)
- 併走したverifier検収も合格: 69+128テストPASS・1M再verify 0エラー独立実測・corpusSha256一致・全11要件の非空洞化確認

## 中(4M生成前の申し送り)

**中-1: expanded1m_provenance_errors のライブ照合緩和(実装者の独断変更)**
- 方向性は妥当(旧実装は「generator保守編集で検証が永久不合格」の自壊構造。データ成果物3種の厳密照合は維持、corpusSha256でjsonl本体のアンカーも追加済み)。
- ただし teacherCandidatesToolSha256 の緩和だけは質が違う: verifyは teacher_candidates.exe 自身を再計算オラクルに使うため、緩和後は別物バイナリでも黙って検証オラクルに採用される(checkpointのtoolSha256指紋はresume時のみ有効、初回フルスキャンは無防備)。「非空文字列」チェックはhex形式すら見ない。
- 代替案: (i)ライブ不一致の警告化+64桁hex形式検査(最小差分)、(ii)記録済みgitCommitから `git show <commit>:...` のSHAと照合(保守編集に頑健かつ改ざん検知維持、最も筋が良い)、(iii)--strict-provenanceフラグ。**4M生成前に(ii)の採用を検討**。

**中-2: 新設エラーメッセージの復旧手順が expanded1m 系setでは実行不能**
- A2/A3のエラーが案内する --start-fresh / --adopt-provenance を、main()はexpanded1mに対してSystemExitで拒否する。expanded1mはedaxExeを持つ唯一のsetなので、案内された脱出フラグがCLIで使えない。実際の復旧(シャードjsonl+metaペア削除→base import再実行)がどこにも書かれていない。4M系セットが同方式を踏襲する前にメッセージまたはドキュメント追記。

## 軽微

1. finalize成功系テストのモック空洞化(実集計→ゲート通過→書き出しの成功経路をモック無しで通すテストがない。失敗系2件は実集計使用で統合の大半は生存)。ゲート通過可能な合成fixture追加が望ましい。
2. K=1 SHA固定テストのfilesUsed正規化が無検証上書き(環境依存性は精査済みで頑健。SHAはブートストラップ値=T127a仕様どおり)。
3. pre-T143のverify checkpointは指紋欄なしのため次回必ずフルスキャン(安全側、挙動変化として記録)。
4. validated_progress_every の負値エッジ(-1→0で無効化、実害なし)。
5. finalizeゲートのrecordsはprogress.totalとのみ比較(1,000,000定数照合なし。verify側が別途強制、実害薄)。

## 重点観点の確認結果(問題なし)

- A1 逐次checkpoint: append単位の書込+fsync+done_ids登録、resumeはjsonl実体からdone_ids再構築+不正末尾truncate。二重append・欠落は構造的に排除(appendをelse節に置いた設計も適切)。
- A2: 既存3set完全不変(edaxExeSha256キー自体を生成しない)。plan provenanceを歴史的記録として保持した判断も適切。
- B5: 指紋計算はverify_one 1回につき1回、性能退行なし。
- B6/B7: ゲート3条件網羅(assert文でなくRuntimeErrorなので-Oでも有効)、append冪等・相違時拒否・他フィールド不変。
- waterfall固定配列は手トレースで独立確認。manifest差分はcorpusSha256 1フィールドのみで実測値と一致。
