# パシリ 設計書

この文書は「何を・なぜそう作ったか」をまとめたものです。実装と食い違ったら実装側を直すか、この文書を直してください。

- [1. 全体構成](#1-全体構成)
- [2. データモデル](#2-データモデル)
- [3. 注文の状態遷移](#3-注文の状態遷移)
- [4. お金の流れと計算](#4-お金の流れと計算)
- [5. 設定値](#5-設定値)
- [6. アクセス台帳（出入り口の管理）](#6-アクセス台帳出入り口の管理)
- [7. 通行記録台帳・お金の台帳](#7-通行記録台帳お金の台帳)
- [8. 仕様にない判断（安全側に倒したもの）](#8-仕様にない判断安全側に倒したもの)

---

## 1. 全体構成

```
ブラウザ（スマホ）
   │  すべてのリクエスト
   ▼
┌──────────────────────────────────────────┐
│ 門番 (src/server/gate)                    │
│  ・画面   → middleware.ts から gate を呼ぶ │
│  ・API    → app/api/[...path] から dispatch│
│  1. セッション確認（だれか）               │
│  2. アクセス台帳と照合（デフォルト拒否）   │
│  3. CSRF・入力検証（zod）                  │
│  4. データ範囲チェック（自分の/担当の/全件）│
│  5. 見せてよい項目だけに絞って返す         │
│  6. 通行記録台帳に追記（許可・拒否とも）   │
└──────────────────────────────────────────┘
   │
   ▼
各処理 (src/server/endpoints) ── 状態遷移 (src/server/domain/orderState.ts)
   │                           ├ 報酬計算 (src/server/domain/pricing.ts) ※純粋関数
   │                           └ 決済 (src/server/payments) ← Stripe / モック
   ▼
PostgreSQL（Prisma）

定期処理ワーカー (src/worker.ts, role=system)
   自動完了 / 期限切れ / パシリへの送金 / Stripe との照合
```

- **API の入口は1つだけ**（`src/app/api/[...path]/route.ts`）。ここで台帳を見て、登録済みの処理に振り分けます。台帳にないパスは処理まで届きません。
- 画面は Next.js の `middleware.ts`（Node.js ランタイム）で門番を通します。
- 決済は `PaymentGateway` という共通の形（インターフェース）を通して呼びます。`.env` に Stripe のテストキーがあれば本物の Stripe（テストモード）、なければモック（偽物の Stripe）を使います。**本番キー（`sk_live_`）を入れると起動を拒否します。**

## 2. データモデル

正確な定義は `prisma/schema.prisma` にあります。主なテーブル：

| テーブル | 役割 |
|---|---|
| User / UserRole | ユーザーとロール（1人が複数ロールを持てる）。`system` ロールは DB に存在せず、ログイン不可 |
| Session / LoginAttempt / EmailVerification | ログイン状態、試行回数制限、メール確認 |
| Area / Shop / ShopMember / Product / RunnerPerk | エリア、店、店の担当者、商品、パシリ特典 |
| Setting / SettingOverride / SettingChange | 設定値、エリア別・店舗別の上書き、変更履歴 |
| Order / OrderItem / OrderTransition | 注文、注文明細、状態遷移の記録 |
| Run / Receipt | パシリの「1回のおつかい」（複数注文のまとめ）、レシート画像 |
| Payment / Payout | 仮押さえ・本決済（注文ごと）、パシリへの送金（注文ごと） |
| Rating / Dispute / Notification | 評価とありがとうメッセージ、トラブル申告、運営への通知 |
| AuditLedger | 通行記録台帳（追記専用・ハッシュチェーン） |
| MoneyJournal / MoneyLine | お金の台帳（複式簿記の仕訳と明細行、追記専用） |
| ReconciliationRun | Stripe との照合結果 |
| IdempotencyRecord / WebhookEvent | 二重処理防止（同じ要求・同じ Webhook を1回だけ処理） |

**金額はすべて円の整数**で持ちます（小数の誤差を避けるため）。率の計算結果は切り上げ（お客さんの仮押さえ）または四捨五入（手数料）で、どちらを使うかは `pricing.ts` に明記しています。

## 3. 注文の状態遷移

```
          (与信成功)        (パシリ確定)       (レシート登録)       (届けた)        (受け取り/自動)
 draft ───────────▶ placed ─────────▶ matched ─────────▶ purchased ─────────▶ delivered ─────────▶ completed
   │                 │  ▲               │                   │                    │
   │                 │  └─(パシリ辞退)──┤                   │                    │
   ▼                 ▼                  ▼                   ▼                    ▼
 expired          cancelled          cancelled           disputed ◀──────────── disputed
                  expired                                   │
                                                            └─(admin)─▶ completed / cancelled
```

許可する遷移（これ以外はサーバーが拒否）：

| from | to | だれが | 条件 |
|---|---|---|---|
| draft | placed | system（決済の与信成功時） | 与信が成功している |
| draft | expired | system | `order_expire_minutes` 経過 |
| placed | matched | runner | 自分の注文でない、立替上限・まとめ上限以内、入金口座の登録済み |
| placed | cancelled | customer | いつでも |
| placed | expired | system | `order_expire_minutes` 経過（仮押さえを解放） |
| matched | placed | runner | 引き受けから `cancel_deadline_minutes` 以内（パシリの辞退） |
| matched | cancelled | customer | 引き受けから `cancel_deadline_minutes` 以内 |
| matched | purchased | runner（担当） | レシート画像と実額を登録 |
| purchased | delivered | runner（担当） | 承認が必要な場合は承認済み |
| purchased | disputed | customer / runner | 承認を拒否した場合も自動でここへ |
| delivered | completed | customer / runner（受け取りコード）/ system（自動完了） | 本決済が成功 |
| delivered | disputed | customer | 受け取り前のトラブル申告 |
| disputed | completed | admin | 本決済して終わる |
| disputed | cancelled | admin | 仮押さえを解放して終わる |

- 遷移はすべて `OrderTransition` に「いつ・だれが（ユーザーとロール）・何から何へ・理由」を記録し、通行記録台帳にも書きます。
- 同時に2人が操作しても壊れないよう、`UPDATE ... WHERE status = 期待する状態` で更新し、0件なら「すでに状態が変わった」として拒否します。

## 4. お金の流れと計算

### 4-1. 金額の計算（`src/server/domain/pricing.ts`、純粋関数）

| 項目 | 計算 |
|---|---|
| 商品見積 | Σ(単価 × 個数)（注文時点の価格） |
| 配達料（注文1件ぶん） | ⌈(基本報酬 + 雨の日割増 + 早朝割増 + 距離割増) ÷ まとめた件数⌉ + 1件ごとの報酬 |
| 距離割増 | ⌈距離km⌉ × 1kmごとの割増。距離は「店から一番遠い受け渡し場所まで」 |
| 運営手数料 | round(商品実額 × 運営手数料率) |
| お客さんの支払い | 商品実額 + 配達料 + 運営手数料 |
| 仮押さえ額 | ⌈見積合計 × (1 + 仮押さえ上乗せ率)⌉。見積は「1件だけで頼んだ場合」（＝配達料が最大）で計算 |
| パシリの受け取り | Σ(商品実額 + 配達料) ＝ 立替代金 + 報酬 |

- まとめる件数が多いほど、1人あたりの配達料は安くなります（基本報酬を割り勘するため）。
- 計算に使う設定値は **各注文の注文時点スナップショット**。まとめた注文ごとに自分のスナップショットで配達料を出し、その合計がパシリの報酬です。
- 雨の日かどうかは admin が設定 `rain_active` で切り替えます（パシリの自己申告にしない）。早朝かどうかは「パシリが引き受けた時刻」が `early_hours` に入るかで決めます。

### 4-2. 承認が必要になる条件（購入時）

1. 最終合計 ＞ 仮押さえ額 → 承認 ＋ 新しい金額での与信のやり直し
2. |商品実額 − 商品見積| ÷ 商品見積 ＞ 許容率 → 承認
3. 売り切れ・代替品がある → 承認

承認待ちの間は「届けた」にできません。お客さんが拒否すると `disputed` になり、運営が対応します。

### 4-3. Stripe Connect 上での資金の流れ

```
お客さんのカード ──(与信: 手動キャプチャ)──▶ Stripe（プラットフォームのアカウント）
                    受け取り時に実額だけキャプチャ、残りは自動で解放
                                    │
                                    ├─(Transfer: 実額 + 配達料, source_transaction 指定)──▶ パシリの Connect アカウント ─▶ パシリの銀行口座
                                    └─ 運営手数料だけがプラットフォームに残る
```

- 方式は Stripe の「Separate charges and transfers」。注文時点ではパシリが決まっていないため、宛先を後から決められるこの方式にしています。
- 送金（Transfer）は `source_transaction` で元の決済に結び付け、決済の入金が確定した資金からのみ送られます。運営の銀行口座をお金が通ることはありません。
- **ただし、この方式が日本の法令（資金決済法・収納代行の扱いなど）上どう評価されるかは専門家の確認が必要です。** README の本番前チェックリストに記載しています。

### 4-4. 二重決済の防止（冪等性）

- Stripe へのすべての書き込み要求に「冪等キー」を付けます（例：`capture:{paymentId}`）。同じキーの要求は Stripe 側で1回分しか処理されません。
- DB 側も `IdempotencyRecord`（主キー＝冪等キー）、`MoneyJournal.idempotencyKey`（ユニーク）、`WebhookEvent.id`（ユニーク）で、同じ処理を2回記録できないようにしています。
- 受け取り（本決済）は「状態を条件付き更新で確保 → キャプチャ → 完了」の順。途中で落ちても、定期処理が同じ冪等キーでやり直します。

## 5. 設定値

- 初期値：`config/settings.default.yaml`（キー・値・型・単位・説明・最小・最大）
- 初回起動時（seed）に DB の `Setting` へ投入。**すでに DB にあるキーは上書きしません**（運営が変えた値を守るため）。
- 優先順位：店舗別上書き ＞ エリア別上書き ＞ 全体の値
- 注文時に、その店で有効な値を全部まとめて `Order.settingsSnapshot` に保存。以後その注文の計算はスナップショットだけを使います。
- 「これから始める操作」の上限（立替上限・まとめ件数の上限）は、操作する時点の値を使います（安全側：設定を厳しくしたら即座に効く）。
- 変更・上書き・削除・差し戻しはすべて `SettingChange` と通行記録台帳に残ります。

キーの一覧と意味は `config/settings.default.yaml` を見てください（説明つき）。

## 6. アクセス台帳（出入り口の管理）

ファイル：`security/access_ledger.yaml`

```yaml
- id: api.customer.orders.show        # 出入り口の名前（コードとの対応に使う）
  kind: api                           # api / page / webhook / job / file / export
  method: GET
  path: /api/customer/orders/:id
  resource: order                     # データ範囲チェックの対象
  grants:
    - role: customer                  # だれに
      ops: [read]                     # 何を（read/create/update/delete）
      scope: own                      # どの範囲（own/assigned/shop/all/public/self）
      fields: [id, status, items[].name, ...]   # 見せてよい項目
      reason: 自分の注文の進行状況を見るため    # 理由
```

| scope | 意味 |
|---|---|
| public | だれでも（ログイン不要の画面・ログイン API のみ） |
| self | 自分のユーザー情報 |
| own | 自分が注文者のもの |
| assigned | 自分が担当パシリのもの |
| shop | 自分が所属する店のもの |
| nearby | 自分の注文を除く、引き受け待ちの注文（パシリ向け一覧） |
| all | 全件（admin・system のみ） |

- 台帳にない出入り口・台帳にないロールは **すべて拒否**（デフォルト拒否）。
- 起動時チェック（`src/server/gate/startupCheck.ts`）：コード上の API・画面・定期処理と台帳を突き合わせ、ずれていれば起動失敗。テストでも同じチェックを実行。
- 見せてよい項目は門番が最後に絞り込みます（処理が余計な項目を返しても外に出ない）。条件付きの項目（例：電話番号は `purchased` の間だけ）は `when` で書きます。
- `require_reason: true` の出入り口（admin の個人情報閲覧）は理由の入力が必須で、理由は通行記録に残ります。

## 7. 通行記録台帳・お金の台帳

### 通行記録台帳（AuditLedger）
- 記録：日時、ユーザー、ロール、出入り口、操作、対象、結果（allow/deny/error/info）、IP、補足。
- パスワード・カード番号・トークン・受け取りコードは記録しません（記録前に除去する仕組みあり）。
- **追記専用**：DB のトリガーで UPDATE / DELETE を拒否。
- 各行の `hash` ＝ SHA-256(直前の行の hash ＋ この行の内容)。1行でも書き換えると、それ以降の連鎖が合わなくなり検知できます（管理画面の「改ざんチェック」）。
- 異常検知：設定 `anomaly_window_minutes` 分の間に `anomaly_deny_threshold` 回以上拒否されたユーザー/IP を管理画面に表示。

### お金の台帳（MoneyJournal / MoneyLine）
1つのイベント＝1つの仕訳。仕訳の借方合計と貸方合計は必ず一致（DB の保存前と照合時にチェック）。

| イベント | 借方 | 貸方 |
|---|---|---|
| hold（仮押さえ） | hold:authorized | hold:customer_commitment |
| release（解放） | hold:customer_commitment | hold:authorized |
| capture（本決済） | hold:customer_commitment / stripe:platform_balance | hold:authorized / payable:runner |
| fee（運営手数料） | payable:runner | revenue:platform_fee |
| payout（パシリへ送金） | payable:runner | stripe:platform_balance |
| refund（返金。送金前のみ） | payable:runner / revenue:platform_fee | stripe:platform_balance |

- 残高は「仕訳の合計」で出します。残高の列を直接書き換えることはしません。
- 毎日の照合（`reconcile` 定期処理）：台帳の各仕訳と Stripe（またはモック）の記録を突き合わせ、金額・状態の差異があれば `ReconciliationRun` に記録し、admin に通知します。

## 8. 仕様にない判断（安全側に倒したもの）

| 判断 | 理由 |
|---|---|
| ロール `anonymous`（未ログイン）を台帳に追加 | ログイン画面・Webhook など「ログイン前」の出入り口も台帳で管理するため |
| Stripe キー未設定時はモック決済で動く。`sk_live_` は起動拒否 | 初心者がすぐ試せるように。本番キーの誤投入を防ぐ |
| パシリの辞退（matched → placed）を追加 | パシリ側の期限内キャンセル手段がないと、お客さんの注文が宙に浮くため |
| 承認拒否は `cancelled` でなく `disputed` へ | パシリはすでに立て替えているので、運営が間に入る |
| 電話番号・住所は `purchased`（配達中）の間だけパシリに見せる | 「配達中のみ」を最も狭く解釈 |
| 雨の日割増は admin が切り替える | パシリの自己申告だと不正に使える |
| 受け取りコード（6桁）の入力回数に上限 | 総当たりで勝手に受け取り完了にされるのを防ぐ |
| 上限系（立替上限・まとめ件数）は操作時点の設定値 | 設定を厳しくしたらすぐ効く方が安全 |
| ログイン試行回数・セッション期限なども設定値に入れた | ハードコード禁止の方針に合わせる |
| 返金は「パシリへの送金前」のみ管理画面から可能 | 送金後の返金は Transfer の取り消しが絡み、人の判断が必要なため（README に手順を記載） |
| レシート画像は JPEG/PNG/WebP のみ、中身（先頭バイト）で判定 | 拡張子だけだと偽装できるため |
