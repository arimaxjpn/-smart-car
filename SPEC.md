# Smart Car 運転日誌システム 仕様書

最終更新: 2026-03-10

---

## システム概要

業務用車両の乗車・降車を記録するWebアプリ。
iPhoneのSafariから操作し、データをGoogleスプレッドシートに自動記録する。

```
iPhone Safari（PWA / GitHub Pages）
  ↕ HTTPS fetch POST/GET
Google Apps Script（バックエンド）
  ↕
Googleスプレッドシート（データ）＋ Google Drive（写真）＋ Gemini API（OCR）
```

---

## ファイル構成

| ファイル | 場所 | 役割 |
|---|---|---|
| `index.html` | GitHub Pages・ローカル | PWAフロントエンド |
| `Code.gs` | GASエディタ・ローカル | バックエンド全処理 |
| `DESIGN.md` | ローカル | UIデザインルール（共通） |
| `SPEC.md` | ローカル | この仕様書 |
| `README.md` | ローカル・GitHub | プロジェクト状況まとめ |

**ホスティング方針**
- `index.html` → GitHub Pages（https://arimaxjpn.github.io/-smart-car/）から配信
- `Code.gs` → GASエディタ上でデプロイ（URLは固定）
- ローカルの `C:\Users\Dai\Desktop\Smart_Car\` がリポジトリのローカルコピー

---

## デプロイ設定

- 種類: ウェブアプリ
- 実行ユーザー: 自分（スプレッドシートオーナー）
- アクセス: 全員（匿名を含む）
- **コード変更後は必ず「新しいバージョン」として再デプロイすること**

---

## スプレッドシート構成

### 運転日誌シート（メインデータ）★2026-03-01列構成更新済み

| 列 | 項目 | 備考 |
|---|---|---|
| A | ID | 連番（自動採番） |
| B | 乗車日時 | ISO 8601形式 |
| C | 乗車地（緯度） | GPS |
| D | 乗車地（経度） | GPS |
| E | 乗車地（住所） | Nominatim API |
| F | 乗車メーター写真URL | Google Drive URL |
| G | OCR生データ（乗車） | Gemini APIの生レスポンス |
| H | 開始メーター値 | OCRで自動抽出 |
| I | 降車日時 | |
| J | 降車地（緯度） | |
| K | 降車地（経度） | |
| L | 降車地（住所） | Nominatim API |
| M | 降車メーター写真URL | Google Drive URL |
| N | OCR生データ（降車） | Gemini APIの生レスポンス |
| O | 終了メーター値 | OCRで自動抽出 |
| P | 業務目的 | |
| Q | 走行距離（km） | =IF(AND(H<>"",O<>""),O-H,"") |
| R | ステータス | `open` / `closed` |
| S | 作成日時 | |

### 設定シート

| セル | 項目 |
|---|---|
| B2 | 運転者名 |
| B3 | 車両情報 |
| B4 | 単価（円/km） |
| B5 | Google DriveフォルダID（自動設定） |
| B6 | 認証トークン（32文字） |
| B7 | Gemini APIキー |

### 編集ログシート

電子帳簿保存法対応。データ修正時に自動記録。

### 運転日誌シートの表示ルール

- 日時列（B, I）は `yyyy/MM/dd HH:mm`
- 緯度・経度（C, D, J, K）は小数点以下2桁
- 開始/終了メーター値（H, O）と走行距離（Q）は `#,##0` で右寄せ
- 住所列（E, L）と業務目的（P）のみ折り返し
- ステータス（R）は `open` を黄色系、`closed` を緑系で表示
- OCR失敗セル（G, N）は警告色で表示
- 走行距離（Q）が 500km 超のときは警告色で表示

### 新規行の書式自動適用（★2026-03-10追加）

`applyJournalFormat()` は既存行のみに書式を当てる手動関数。
新しく追加された行は `formatNewRow_(sheet, rowNum)` で自動的に書式設定される。

- 呼び出し元: `startTrip_()` → `sheet.appendRow()` 直後
- 適用内容: セル配置・数値フォーマット・折り返し設定・セルパディング（上下5px・左右10px）
- これにより手動で `applyJournalFormat()` を再実行しなくても書式が維持される

---

## API仕様

### GET リクエスト

#### ステータス確認
```
GET {GAS_URL}?action=status&token={TOKEN}

レスポンス（乗車中なし）:
{ "success": true, "hasOpenTrip": false }

レスポンス（乗車中あり）:
{
  "success": true,
  "hasOpenTrip": true,
  "tripId": 5,
  "odometer": 12345,
  "startDatetime": "2026-02-24T09:00:00.000Z",
  "startAddress": ""
}
```

### POST リクエスト

全リクエストに `token` フィールド必須。Content-Type: text/plain（CORSエラー回避）。

#### 乗車記録
```json
{
  "token": "xxx",
  "type": "start",
  "datetime": "2026-02-24T09:00:00.000Z",
  "lat": 35.123,
  "lon": 139.456,
  "address": "",
  "purpose": "現場移動",
  "photo": "base64文字列"
}
→ { "success": true, "tripId": 5 }
```

#### 降車記録
```json
{
  "token": "xxx",
  "type": "end",
  "tripId": 5,
  "datetime": "2026-02-24T18:00:00.000Z",
  "lat": 35.789,
  "lon": 139.012,
  "address": "",
  "photo": "base64文字列"
}
→ { "success": true, "distance": 44, "odometer": 12345 }
```

#### 月次PDFレポート生成
```json
{ "token": "xxx", "type": "report", "year": 2026, "month": 2 }
→ {
  "success": true,
  "pdfUrl": "...",
  "folderUrl": "...",
  "totalDistance": 500,
  "totalAmount": 7500,
  "recordCount": 12,
  "reviewCount": 1,
  "fileName": "2026-02_運転日報.pdf"
}
```

#### データ修正（編集ログ付き）
```json
{
  "token": "xxx",
  "type": "edit",
  "tripId": 5,
  "field": "startOdometer",
  "newValue": "12340",
  "reason": "入力ミス"
}
```
編集可能フィールド: `startOdometer` / `endOdometer` / `startAddress` / `endAddress` / `purpose`

---

## PWAアプリ仕様（index.html）

### UIデザイン

DESIGN.md に準拠（2026-03-05適用済み）:
- フォント: Outfit + IBM Plex Sans JP（Google Fonts）
- カラー: 深い黒基調（#0a0c10）
- ボタン: pill型（border-radius: 9999px）
- カード: 角丸20px、薄ボーダー
- 単位: rem統一

### 画面構成

```
起動
 ↓
[ローディング] → GASステータス確認
 ↓
トークン未設定 → [初回設定画面]
 ↓
hasOpenTrip=false → [乗車画面]
hasOpenTrip=true  → [降車画面]
 ↓
送信完了 → [結果画面] → 再起動
```

### 乗車画面
- 現在時刻・現在地の表示
- 業務目的ボタン: 「現場移動」「前日乗り込み」「その他（テキスト入力）」
- 住所表示は `市区町村 + 町名/地区 + 丁目まで` に短縮
- メーター写真: **アプリ内カメラ**（getUserMedia）＋ガイド枠表示
  - ガイド枠サイズ：画面幅の55%・縦横比1.9:1
  - ガイドラベル：「ODOメーターを枠に合わせて」
  - シャッター後にガイド枠範囲をクロップ、横1024px・JPEG80%にリサイズ
  - 撮影後に写真プレビューと「取り直し」ボタンを写真右下にオーバーレイ表示
  - GASへ base64 で送信 → Google Drive に保存
- GPS: 画面表示時にバックグラウンドで取得開始。送信ボタン押下時に完了を待機

### 降車画面
- 乗車情報表示（乗車時刻・乗車地）
- メーター写真・取り直し機能（乗車と同様）

### 停車検知アラーム
- 走行中（降車画面表示中）にGPS速度を監視
- 速度3km/h未満が1分継続で880Hzビープ音（2秒ごと）
- 画面タップで停止

### OCR機能
- GAS側で自動実行（processOcrBatch、1時間おきトリガー）
- Gemini 2.5 Flash Vision API
- 写真URL → Drive取得 → OCR → スプレッドシートに記録

### データ保存
- 認証トークン: `localStorage` に保存（`smartcar_token`）
- GAS URL: HTMLに直接埋め込み

---

## 連続性チェック

前回の終了メーター値と今回の開始メーター値の差が **500km超** の場合、
降車レスポンスに `continuityAlert` が含まれてトースト通知される。

---

## 月次PDF出力仕様

### 基本ルール

- 対象は `運転日誌` シートの `closed` レコードのみ
- 判定月は `降車日時` ベース
- PDFは報告書用途とし、画像は含めない
- 原本写真は Google Drive にそのまま残す
- 毎月1日 9:00 の自動作成を維持しつつ、`generateMonthlyPDF_(year, month)` の手動実行でも再出力できる

### PDF明細項目

- 日付
- 乗車住所
- 降車住所
- 開始値
- 終了値
- 走行km
- 業務目的

### 集計項目

- 件数
- 合計走行km
- 合計金額

合計金額は `合計走行km × 設定!B4` で算出する。

### 要確認の判定

次のいずれかに当てはまる行は、月報本体ではなく `要確認一覧` に分離する。

- 開始値が未確定
- 終了値が未確定
- 走行kmが未確定
- 乗車OCR / 降車OCR が未確定
- 終了値が開始値より小さい
- 走行kmがマイナス
- 走行kmが 500km を超える
- 走行km と `終了値 - 開始値` が一致しない

`要確認一覧` に入った行は、合計件数・合計走行km・合計金額に含めない。

### 保存先

- 設定シート `B5` の Drive フォルダ配下に `月報PDF` フォルダを作成して保存
- ファイル名は `YYYY-MM_運転日報.pdf`
- 同名ファイルがある場合は旧ファイルをゴミ箱に移してから保存する

### 月次PDF自動生成

毎月1日 9:00 に前月分を自動生成。
`setupSheets()` 実行時にトリガーが登録される。

---

## 月次アーカイブパック仕様（★2026-03-10追加）

### 概要

毎月1日 9:00 に、前月分のデータ一式を Google Drive にまとめて保存する。
元データは削除しない。アーカイブのみ。

### 処理関数

- `createMonthlyPack(year, month)`: 指定月のパックを作成
- `monthlyAutoReport()`: 毎月1日のトリガー関数。前月の `createMonthlyPack()` を呼び出す
- `createPackForMarch2026()`: 手動テスト用ショートカット

### アーカイブフォルダ構成

```
SmartCar_写真/
└── アーカイブ/
    └── YYYY-MM/
        ├── YYYY-MM_運転日誌.gsheet   ← 月間走行データ（Googleスプレッドシート）
        ├── YYYY-MM_運転日報.pdf      ← 月次PDFレポート
        └── 写真/
            ├── meter_*.jpg          ← 乗車時メーター写真のコピー
            └── meter_*.jpg          ← 降車時メーター写真のコピー
```

### 対象データ

- 判定月は `乗車日時`（B列）のYYYY-MMで絞り込む
- `closed` / `open` 問わず全レコードを対象とする
- 写真は F列（乗車）・M列（降車）のDrive URLから取得してコピー

### トリガー動作（`monthlyAutoReport`）

- 実行タイミング: 毎月1日 9:00（`setupSheets()` でトリガー登録済み）
- 実行内容: `createMonthlyPack(前月年, 前月月)`
- UIアラートは使わない（トリガー実行ではUI不可のためtry/catchで回避、ログのみ）

---

## 現在の課題・未実装

- [x] 住所の自動取得 → `getAddress()` 実装済み（Nominatim API）
- [x] カメラ → アプリ内カメラ＋ガイド枠表示
- [x] 撮影後に「取り直す」ボタンを表示
- [x] 画像圧縮 → 横1024px・JPEG80% で自動リサイズ
- [x] GPS → 画面表示時にバックグラウンド取得開始
- [x] OCR → Gemini 2.5 Flash（GASトリガー自動実行）
- [x] 業務目的ボタン → 横3列レイアウト
- [x] 停車検知アラーム → 実装済み（2026-03-04）
- [x] UIデザイン刷新 → DESIGN.md準拠（2026-03-05）
- [x] バージョン表示 → `_VERSION`定数方式に変更（v0.1）
- [x] CLAUDE.md新規作成 → UIルール・技術スタック・開発ルール記載
- [x] AGENTS.md新規作成 → Codex 用プロジェクト固有ルール記載
- [x] スプレッドシート書式調整 → `applyJournalFormat()` 更新（2026-03-07）
- [x] 住所短縮表示 → `formatAddress()` で調整（2026-03-07）
- [x] iPhoneホーム画面に追加済み
- [x] 新規行の書式自動適用 → `formatNewRow_()` 追加・`startTrip_()` から呼び出し（2026-03-10）
- [x] 月次アーカイブパック → `createMonthlyPack()` 追加・`monthlyAutoReport()` に統合（2026-03-10）
- [ ] ホーム画面アイコン用のmanifest.json
- [x] 月次PDF仕様の実装
- [ ] 月次PDFレポートの実データ動作確認
- [ ] **Code.gsをGASエディタに貼り付けて再デプロイ**（★要作業）
- [ ] `createPackForMarch2026()` を手動実行して3月アーカイブをテスト
- [ ] 写真URL列の表示改善

---

## 解決済みの障害

### 障害1: アプリが「接続中...」のまま起動しない（解決済み）
**原因:** `<script>` 内のバッククォート（テンプレートリテラル）を GAS HTML サービスが正しく処理できなかった。
**対処:** `<script>` 内のバッククォートをすべて文字列結合（`+`）に書き換えた。

### 障害2: 乗車記録ボタン押下時に CORS エラー（解決済み）
**原因:** `Content-Type: application/json` で POST するとブラウザがプリフライトリクエストを送るが、GAS はOPTIONS に対応していないため CORS エラーになる。
**対処:** `Content-Type: text/plain` に変更。GAS 側の `JSON.parse(e.postData.contents)` はそのまま動作する。

### Gemini API のモデル名404エラー（解決済み）
**原因:** `gemini-1.5-flash` → `gemini-2.0-flash` → いずれも廃止。
**対処:** `gemini-2.5-flash`（v1betaエンドポイント）に変更して解消。

---

## 初回セットアップ手順

1. GASエディタで `setupSheets()` を実行（シート・フォルダ自動作成）
2. 「設定」シートの B2〜B4 を入力（運転者名・車両情報・単価）
3. 「設定」シートの B7 に Gemini APIキーを入力
4. Code.gs と index.html をGASエディタに貼り付けて保存
5. ウェブアプリとしてデプロイ（新しいバージョン）
6. iPhoneのSafariでデプロイURLを開く
7. 設定シート B6 のトークンをアプリに入力
8. 「ホーム画面に追加」でアイコン化

---

## コード変更時の反映手順

1. GASエディタで該当ファイルを編集・保存
2. デプロイ → デプロイを管理 → 鉛筆アイコン
3. バージョンを「新しいバージョン」に変更してデプロイ
4. URLは変わらない
