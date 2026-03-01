# Smart Car 運転日誌システム 仕様書

最終更新: 2026-03-01

---

## システム概要

業務用車両の乗車・降車を記録するWebアプリ。
iPhoneのSafariから操作し、データをGoogleスプレッドシートに自動記録する。

```
【第一システム：スマホ】
iPhone Safari（PWA）
  ↕ HTTPS / JSON
Google Apps Script（バックエンド）
  ↕
Googleスプレッドシート（データベース）＋ Google Drive（メーター写真保存）

【第二システム：PC・後処理】※開発中
スプレッドシートの写真を順に処理
→ Gemini Vision API（OCR）でメーター値を抽出→ スプレッドシートに記録
```

---

## ファイル構成

| ファイル | 場所 | 役割 |
|---|---|---|
| `Code.gs` | GASエディタ・ローカル | バックエンド全処理 |
| `index.html` | GitHub Pages・ローカル | PWAフロントエンド |
| `SPEC.md` | ローカル（デスクトップ） | この仕様書 |
| `README.md` | ローカル（デスクトップ）・GitHub | プロジェクト状況まとめ |

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

### 運転日誌シート（メインデータ）

| 列 | 項目 | 備考 |
|---|---|---|
| A | ID | 連番（自動採番） |
| B | 乗車日時 | ISO 8601形式 |
| C | 乗車地（緯度） | GPS |
| D | 乗車地（経度） | GPS |
| E | 乗車地（住所） | 現状は空欄 |
| F | 開始メーター値 | km |
| G | OCR生データ（乗車） | Gemini APIの生レスポンス |
| H | 乗車メーター写真URL | Google Drive URL |
| I | 降車日時 | |
| J | 降車地（緯度） | |
| K | 降車地（経度） | |
| L | 降車地（住所） | 現状は空欄 |
| M | 終了メーター値 | km |
| N | OCR生データ（降車） | Gemini APIの生レスポンス |
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
- メーター写真: **アプリ内カメラ**（getUserMedia）＋ガイド枠表示
  - ガイド枠に合わせて撮影することでフレーミングを統一
  - シャッター後にガイド枠範囲をクロップ、横1024px・JPEG80%にリサイズ
  - 撮影後に写真プレビューと「📷 取り直す」ボタンを表示
  - GASへ base64 で送信 → Google Drive に保存
- メーター値入力欄: **なし**（第二システムで後処理）
- GPS: 画面表示時にバックグラウンドで取得開始。送信ボタン押下時に完了を待機

### 降車画面
- 乗車情報表示（乗車時刻・乗車地）
- メーター写真・取り直し機能（乗車と同様）

### OCR機能（第二システム）※開発中
- アプリからは行わない
- 別システムがスプレッドシートの写真URLを読み取りGemini APIでOCR処理
- F列（開始メーター値）・M列（終了メーター値）・P列（走行距離）を後から更新

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

- [x] 住所の自動取得 → `getAddress()` 実装済み（Nominatim API）
- [x] カメラ → アプリ内カメラ＋ガイド枠表示
- [x] 撮影後に「取り直す」ボタンを表示
- [x] 画像圧縮 → 横1024px・JPEG80% で自動リサイズ
- [x] GPS → 画面表示時にバックグラウンド取得開始
- [x] OCR処理をアプリから分離（第二システムで後処理）
- [x] メーター値入力欄を削除（アプリ操作を最小化）
- [x] 乗車・降車の動作テスト完了（PC Chrome・iPhone Safari ともに確認済み）
- [x] iPhoneホーム画面に追加済み
- [ ] 第二システム（OCR・手入力UI）の設計・実装
- [ ] Code.gs を最新版に更新・再デプロイ
- [ ] ホーム画面アイコン用のmanifest.json
- [ ] 月次PDFレポートの動作確認

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

### Gemini API の権限エラー（解決済み）
**原因:** GASで `UrlFetchApp.fetch` を使って外部APIを呼び出す際、初回は権限承認が必要。
**対処:** GASエディタで任意の関数を「手動実行」→「外部サービスへの接続」の権限を承認 → 以降は自動で動作する。

### Gemini API のモデル名404エラー（解決済み）
**原因:** `gemini-1.5-flash` はエンドポイントが変更・廃止。
**対処:** `gemini-2.0-flash`（v1betaエンドポイント）に変更して解消。

### Gemini API のレート制限（一時的）
**原因:** 短時間に大量のOCRテストを行ったため、無料枠のレート制限に達した。
**対処:** 時間をおけば自動解消（通常数時間〜翌日）。本番運用では問題なし。

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
