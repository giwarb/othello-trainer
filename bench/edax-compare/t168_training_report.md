# T168: パターン切り方のEdax寄せ(1/2) — 形状追加+Egaroucid全量学習+スクリーニング

日時: 2026-07-21。実装: implementer(Sonnetフォールバック、T163-T167からの続き)。

## 目的・前提

explorer調査(2026-07-21)により、現本番v5(V3構成38インスタンス+scalar2種、
対Edax lv10で-6.75石)とEdaxの47feature(13種)構成との主差分が
**①隅2x5ブロック(corner5x2、T087で実装済みだが不採用のまま) ②短対角4
(diag4、未実装) ③定数項(バイアス、未実装)** の3つと特定された。B3特徴が
T158不採用→T166本採用に転じた前例に倣い、新体制(Egaroucid全量25.5M+
canonical+早期打ち切り)で①②③を追加した2構成(D1/D2)を再評価する。

## 実装(要件1-5)

- `engine/src/patterns.rs`: `PatternConfig::V3Corner5x2`(D1、既存
  `corner5x2_patterns()`をV3へ追加、46インスタンス・11クラス)・
  `V3Corner5x2Diag4`(D2、新設`diag4_patterns()`〈`diagonal_offset_patterns`と
  同じsymmetry_orbitベース、手書きセル列なし〉を追加、50インスタンス・
  12クラス)。canonical機構(`compute_pattern_classes`/
  `build_canonical_index_table`)は形状非依存で無変更のまま新形状に対応
  することを新規テスト(全8対称一致、D1/D2各100局面)で確認した。
- `engine/src/pattern_eval.rs`: `ScalarFeatureKind::Constant`(値=常に1、
  scale_shift=0、段別バイアスとして学習)を追加。全種一覧
  `ALL_SCALAR_FEATURE_KINDS`を新設し、`score`・`with_zeroed_scalar_features`・
  PWV4/6パース時の上限チェック(2→3)がこれを参照するよう統一。
- `train/src/bin/train_patterns_v3.rs`: 新config`t168-d1`
  (`V3Corner5x2`+モビリティ・囲い度)・`t168-d2`
  (`V3Corner5x2Diag4`+モビリティ・囲い度・定数項)を追加。
- **既存経路の完全不変**: `git stash`でT168差分を退避し、既存config
  (`t158-b3-canonical`、simple-corpus 20,000件サブセット)を学習した
  重みのSHA-256(`6ddda1eb82a82104713ac75c11d9a4ce149ff9b8091224d60ff2b35800e68a77`)を
  記録、`git stash pop`で復元後に再ビルド・再実行し**完全一致**を確認。
- テスト: `cargo test -p engine`239 passed(+3, 2 ignored)・
  `cargo test -p train`149 passed(+1)、両方0 failed。

## 学習マトリクス・コマンド

T165と同一データ・同一分割・同一フラグ:
`--simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17`
(`--simple-max-records`未指定=全量25,514,097行、train_samples=21,210,114)、
`--canonical --early-stop --early-stop-patience 3 --max-epochs 30`、
seeds 1/2/3。output-dirは新規(`train/data/t168/{d1,d2}/`)。

- D1: `--configs t168-d1 --canonical --early-stop --early-stop-patience 3 --max-epochs 30 --seeds <N> --simple-corpus ... --output-dir train/data/t168/d1`
- D2: 同上、`--configs t168-d2 --output-dir train/data/t168/d2`

各runはPowerShell `Start-Process`でdetached起動しログへリダイレクト、完了は
ログの`^result config=`出現をBashの`until`ループ(20秒間隔)で確認する方式
(Monitor通知には依存していない)。6run全て逐次実行。

## 6run結果表

| 構成 | seed | best_epoch | epochs_run | frozen_mse | frozen_mae | 所要時間(概算) | 重みSHA-256 | bytes |
|---|---|---|---|---|---|---|---|---|
| D1(V3+corner5x2) | 1 | 15 | 18 | 35.923338 | **4.492196** | 約20分21秒 | `e69f3b1c33432bafd388af82adde64270ec8c51acaab070bbfff4cf4caf20fc9` | 42,394,905 |
| D1 | 2 | 5 | 8 | 36.738447 | 4.544652 | 約8分52秒 | `ca1867166b1794c512fdfeca647e69fa7d74df6508ee134e716c76f7b8aba8a8` | 42,394,905 |
| D1 | 3 | 13 | 16 | 35.943052 | 4.493399 | 約15分26秒 | `76bc4a652dafcd557713c6a54ff7782d42dacfe80e82a9a48098cd1a4d7ee6d9` | 42,394,905 |
| D2(D1+diag4+定数項) | 1 | 3 | 6 | 37.671805 | 4.591761 | 約6分42秒 | `ec1a5513521361bd73a26d5d170ce10deb537f42b907029d43ac9f54cbe7db3e` | 42,414,950 |
| D2 | 2 | 5 | 8 | 37.176408 | 4.573520 | 約8分32秒 | `fffe2f219909d3c1d560ade6e2452e7f8f81ad39c44ec06b9acd49399c92aae0` | 42,414,950 |
| D2 | 3 | 13 | 16 | 36.355787 | **4.521531** | 約17分39秒 | `b0e44eca76981779881944d93f724635a296661ed30a4e8bfbbec4d3d3944eaa` | 42,414,950 |

太字=各構成内でfrozen MAE最小(事前登録規準1)。

## T165との比較(同一データ・同一分割のため有効、規準2)

| 構成 | ベストseed frozen MAE |
|---|---|
| T165候補C(現行本番、V3+B3、pattern_v5.bin) | 4.702778 |
| D1(V3+corner5x2) | **4.492196**(seed1) |
| D2(D1+diag4+定数項) | **4.521531**(seed3) |

D1・D2ともT165構成C(現行本番)よりfrozen MAEが改善している
(D1: -0.2106、D2: -0.1812、いずれも同一データ・同一分割〈局面ハッシュ
分割〉なので比較は有効、レビュー申し送り1)。

## 事前登録の判定・選定規準の適用結果(要件7)

1. **構成内のベストseed**: D1=seed1(4.492196)、D2=seed3(4.521531)。
2. **最終候補**: frozen MAEがT165構成C(4.702778)より改善している構成
   (D1・D2いずれも該当)のうち最小のもの1つ → **D1 seed1(4.492196)**。
   D2はD1より改善幅が小さい(diag4+定数項の追加がこの学習規模〈全量
   25.5M・patience3〉ではさらなる改善に寄与しなかった、または過学習・
   早期打ち切りタイミングの影響で伸びなかった可能性がある。原因の
   厳密な切り分けは本タスクのスコープ外)。
   **結論: 形状追加(corner5x2)は有効、D1を次段階(T169対局ゲート)の
   候補として確定する。**改善なしでの撤退は今回は該当しない。

## 健全性チェック(要件8)

全6runについて確認、**全run合格・除外なし**:
- (a) val_mae推移が発散していない: 全`*.metrics.tsv`をNaN/Infでgrepし
  該当なし。ログの逐次val_mae値も正常範囲(D1: 4.65-4.83、D2: 4.68-4.96)
  で推移し、patience到達は正常な収束後の停滞。
- (b) 学習済み重みの全8対称一致: 使い捨て検証テスト
  (`engine/tests/t168_health_check.rs`、確認後に削除)で6run全ての実際の
  `.bin`を読み込み、自己対戦40局から6手ごとにサンプルした局面(各440局面)
  ×全8対称でscore完全一致(誤差<1e-2)を確認。
- (c) 係数finite: `from_bytes`のパース自体が非finite値を拒否するため
  構造的に保証されるが、`class_tables`/`scalar_feature_weights`を直接
  走査しても全て有限値であることを再確認した。

(構成Bのseed1限定のような決定性再実行は、T168の受け入れ基準・要件には
含まれていないため実施していない。既存経路不変の実証は上記の通り別途
git stashベースで行った。)

## サイズ実測(要件8、raw/gzip)

| ファイル | raw bytes | gzip bytes |
|---|---|---|
| pattern_v4.bin(旧本番、V3+B3以前) | 27,986,340 | 4,379,795 |
| pattern_v5.bin(現行本番、V3+B3、T165候補C) | 27,986,840 | 5,865,976 |
| D1(V3+corner5x2、seed1) | 42,394,905 | 10,734,273 |
| D2(D1+diag4+定数項、seed1) | 42,414,950 | 10,767,254 |

D1はpattern_v5.bin比でraw +14,408,065バイト(約13.74MB、見積り+13.7MBと
ほぼ一致)、gzip +4,868,297バイト(約4.64MB、+83%)。D2はD1からさらに
raw +20,045バイト・gzip +32,981バイトとごくわずかな増加(diag4は4
インスタンスのみ、定数項は61段×4バイト程度なので妥当)。ブロッカーとは
判断しない(要件に明記の通り)。

## NPS参考値(要件8、ゼロ係数・8局面ベンチ流用)

使い捨てベンチ(`engine/tests/t168_nps_reference.rs`、確認後に削除)で、
`bench/edax-compare/t158a_engine_cost_positions.json`の層化8局面を用いた
`score()`呼び出し単体のマイクロベンチマーク(ゼロ係数canonicalモデル、
V3〈現行形状〉/D1/D2の3者比較)を、他の重い処理と重ならない専有タイミング
(全6run完走後)で実行:

```
evals=160000 v3_nps=2,650,077 d1_nps=2,084,573 d2_nps=1,936,609
ratio(d1/v3)=0.7866 ratio(d2/v3)=0.7308
```

D1はV3比で約21%のNPS低下(インスタンス数38→46)、D2は約27%の低下
(38→50)。表引き回数の増加に概ね比例した低下であり、パターン数増加の
自然な帰結。ゲート判定(実対局でのNPS影響)はT169で行う。

## T169(対局ゲート)向けmanifest

| 候補 | パス | SHA-256 | 形式 | frozen MAE(参考、比較対象=T166ゲート未実施) |
|---|---|---|---|---|
| D1 seed1(最終候補) | `train/data/t168/d1/t168-d1-canonical-seed-1-earlystop.bin` | `e69f3b1c33432bafd388af82adde64270ec8c51acaab070bbfff4cf4caf20fc9` | PWV6 | 4.492196 |

比較相手(T166同様): 現行本番`train/weights/pattern_v5.bin`
(SHA-256 `9ce0cc054b67807641b759a2e881a87dd562146dee5e4d659bba1efa228f54a4`、
T165候補C)。

## metrics.json内`config`フィールドについての注記

T165と同じ制約: `*-earlystop.metrics.json`内の`"config"`フィールドは
`TrainingConfig.name`(`"t168-d1"`/`"t168-d2"`)の素の名前であり、
`--canonical`フラグを反映しない。canonical化の有無はファイル名の
`run_name`サフィックス(`-canonical`)とマジックバイト(PWV6)で判別する。
本レポートの集計はファイル名/run_name基準で行った。

## スコープ外(本タスクでは行っていない)

- 対局ゲート・採否・本番配線(T169、D1候補が対象)
- WASM側の変更
- diag4・定数項単独での寄与の切り分け(D2がD1を上回らなかった原因分析)
