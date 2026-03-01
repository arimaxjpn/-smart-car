# Smart Car 運転日誌アプリ

最終更新: 2026-03-01（午後）

## 一言で言うと

業務用車両の乗車・降車をiPhoneで記録し、Googleスプレッドシートに自動保存するPWAアプリ。
OCR処理は別システムで後から行う二段構成。

---

## 仕組み

```
【第一システム：スマホ】
iPhone Safari（GitHub Pages）
  ↕ HTTPS fetch POST/GET
Google Apps Script（バックエンド）
  ↕
Googleスプレッドシート（データ）＋ Google Drive（写真）

【第二システム：PC・後処理】※開発中
スプレッドシートの写真を順に処理
→ Gemini Vision API（OCR）でメーター値を抽出
→ スプレッドシートに記録
```

| サービス | 役割 |
|---|---|
| GitHub Pages | アプリ画面（index.html） |
| Google Apps Script | データ処理・スプレッドシート書き込み・Drive保存 |
| Googleスプレッドシート | 走行記録データベース |
| Google Drive | メーター写真の保存先 |
| Gemini 2.0 Flash Vision | メーター値OCR（第二システムで使用） |

---

## デプロイ手順

**フロントエンド（index.html）を変更したとき**
```
git add index.html
git commit -m "変更内容"
git push origin main
```

**バックエンド（Code.gs）を変更したとき**

GASエディタ → デプロイ → デプロイを管理 → 鉛筆アイコン → 新しいバージョン → デプロイ

---

## 重要メモ

| 項目 | 値 |
|---|---|
| アプリURL | https://arimaxjpn.github.io/-smart-car/ |
| GitHubリポジトリ | https://github.com/arimaxjpn/-smart-car |
| GAS URL | https://script.google.com/macros/s/AKfycbzSPja787LxEq4DyC74h62l0Zyac-wi8ZVQEdJIUnF6qTwYUh_ohODj0CkxbulH-L9h/exec |
| 認証トークン | c19656ae5f7f4768bad1999f3580809f |
| ローカルファイル | `C:\Users\Dai\Desktop\Smart_Car\` |

---

## 現在の状態

- [x] 乗車・降車の記録・スプレッドシート保存
- [x] メーター写真のDrive保存（圧縮済み：横1024px・JPEG80%）
- [x] カメラ：アプリ内カメラ＋ガイド枠表示（画面幅65%・ズーム不要サイズ）
- [x] 撮影後に「📷 取り直し」ボタンを写真右下にオーバーレイ表示
- [x] 乗車ボタン名「記録開始」・送信中ステータス表示バグ修正
- [x] GPS取得：画面表示時にバックグラウンド開始（送信時の待ち時間を削減）
- [x] スプレッドシートの書式設定（ヘッダー・列幅・日付フォーマット）
- [x] iPhoneホーム画面に追加・実動作確認済み
- [x] GitHubからpushでデプロイ可能

---

## 残っている課題

- [ ] 第二システム（OCR・手入力UI）の設計・実装
- [ ] Code.gs を最新版に更新・再デプロイ（旧バージョンでも動作は可能）
- [ ] ホーム画面アイコン（manifest.json）
- [ ] 月次PDFレポートの動作確認
