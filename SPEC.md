# Smart Car 運転日誌システム 仕様書

最終更新: 2026-02-25

---

## システム概要

業務用車両の乗車・降車を記録するWebアプリ。
iPhoneのSafariから操作し、データをGoogleスプレッドシートに自動記録する。

```
iPhone Safari（PWA）
  ↕ HTTPS / JSON
Google Apps Script（バックエンド）
  ↕
Googleスプレッドシート（データベース）
  +
Google Drive（メーター写真保存）
```

---

## ファイル構成

| ファイル | 場所 | 役割 |
|---|---|---|
| `Code.gs` | GASエディタ | バックエンド全処理 |
| `index.html` | GASエディタ | PWAフロントエンド |
| `SPEC.md` | デスクトップ | この仕様書 |

---

## デプロイ設定

- 種類: ウェブアプリ
- 実行ユーザー: 自分（スプレッドシートオーナー）
- アクセス: 全員（匿名を含む）
- **コード変更後は必ず「新しいバージョン」として再デプロイすること**

---

## スプレッドシート構成

### 運転日誌シート（メインデータ）

| 列 | 項目 | 備考 |
|---|---|---|
| A | ID | 連番（自動採番） |
| B | 乗車日時 | ISO 8601形式 |
| C | 乗車地（緯度） | GPS |
| D | 乗車地（経度） | GPS |
| E | 乗車地（住所） | 現状は空欄 |
| F | 開始メーター値 | km |
| G | OCR生データ（乗車） | 現状未使用 |
| H | 乗車メーター写真URL | Google Drive URL |
| I | 降車日時 | |
| J | 降車地（緯度） | |
| K | 降車地（経度） | |
| L | 降車地（住所） | 現状は空欄 |
| M | 終了メーター値 | km |
| N | OCR生データ（降車） | 現状未使用 |
| O | 降車メーター写真URL | Google Drive URL |
| P | 走行距離（km） | M - F で自動計算 |
| Q | 業務目的・訪問先 | |
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

### 編集ログシート

電子帳簿保存法対応。データ修正時に自動記録。

---

## API仕様

### GET リクエスト

#### HTMLアプリ取得
```
GET {GAS_URL}
→ PWA HTMLを返す（パラメータなし）
```

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

全リクエストに `token` フィールド必須。Content-Type: application/json。

#### 乗車記録
```json
{
  "token": "xxx",
  "type": "start",
  "datetime": "2026-02-24T09:00:00.000Z",
  "lat": 35.123,
  "lon": 139.456,
  "address": "",
  "odometer": 12345,
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
  "odometer": 12389,
  "photo": "base64文字列"
}
→ { "success": true, "distance": 44, "odometer": 12345 }
```

#### 月次PDFレポート生成
```json
{ "token": "xxx", "type": "report", "year": 2026, "month": 2 }
→ { "success": true, "pdfUrl": "...", "totalDistance": 500, "totalAmount": 7500, "recordCount": 12 }
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
- 業務目的ボタン: 「現場移動」「前日乗り込み」「その他（テキスト入力）」
- メーター写真: カメラ撮影 → base64変換
- メーター値: 数値入力（手動）
- GPS: 自動取得（バックグラウンド）

### 降車画面
- 乗車情報表示（乗車時刻・乗車時メーター）
- メーター写真・メーター値入力（乗車と同様）

### データ保存
- 認証トークン: `localStorage` に保存（`smartcar_token`）
- GAS URL: HTMLに直接埋め込み（テンプレート変数 `<?= gasUrl ?>`）

---

## 連続性チェック

前回の終了メーター値と今回の開始メーター値の差が **500km超** の場合、
降車レスポンスに `continuityAlert` が含まれてトースト通知される。

---

## 月次PDF自動生成

毎月1日 9:00 に前月分を自動生成。
`setupSheets()` 実行時にトリガーが登録される。

---

## 現在の課題・未実装

- [x] 住所の自動取得 → index.html に `getAddress()` 実装済み（Nominatim API）※動作未確認
- [ ] OCR機能（メーター写真から数値を自動読み取り）
- [ ] ホーム画面アイコン用のmanifest.json
- [ ] オフライン対応（Service Worker）
- [x] 乗車・降車の動作テスト完了確認（PC Chrome で確認済み）
- [ ] iPhone Safari での動作確認・ホーム画面追加

---

## 解決済みの障害

### 障害1: アプリが「接続中...」のまま起動しない（解決済み）
**原因:** `<script>` 内のバッククォート（テンプレートリテラル）を GAS HTML サービスが正しく処理できなかった。
**対処:** `<script>` 内のバッククォートをすべて文字列結合（`+`）に書き換えた。

### 障害2: 乗車記録ボタン押下時に CORS エラー（解決済み）
**原因:** `Content-Type: application/json` で POST するとブラウザがプリフライトリクエストを送るが、GAS はOPTIONS に対応していないため CORS エラーになる。
**対処:** `Content-Type: text/plain` に変更。GAS 側の `JSON.parse(e.postData.contents)` はそのまま動作する。

### GAS デプロイ直後の関数一覧ページ表示について
再デプロイ直後にアクセスすると、アプリ画面ではなく関数一覧（`doGet(Object e)` 等）が表示されることがある。GAS のデプロイ反映遅延によるもの。数秒待って再読み込みすれば解消する。

### 環境状態
| 項目 | 状態 |
|---|---|
| `setupSheets()` 実行 | 完了 |
| 設定シート B2・B3（運転者名・車両情報） | 未入力 |
| 設定シート B4（単価） | 15円/km |
| 設定シート B6（認証トークン） | `c19656ae5f7f4768bad1999f3580809f` |
| デプロイ設定 | 実行ユーザー：自分、アクセス：全員 ✅ |
| PC Chrome 動作確認 | 乗車・降車ともに完了 ✅ |

---

## 初回セットアップ手順

1. GASエディタで `setupSheets()` を実行（シート・フォルダ自動作成）
2. 「設定」シートの B2〜B4 を入力（運転者名・車両情報・単価）
3. Code.gs と index.html をGASエディタに貼り付けて保存
4. ウェブアプリとしてデプロイ（新しいバージョン）
5. iPhoneのSafariでデプロイURLを開く
6. 設定シート B6 のトークンをアプリに入力
7. 「ホーム画面に追加」でアイコン化

---

## コード変更時の反映手順

1. GASエディタで該当ファイルを編集・保存
2. デプロイ → デプロイを管理 → 鉛筆アイコン
3. バージョンを「新しいバージョン」に変更してデプロイ
4. URLは変わらない
