# Smart Car プロジェクト 開発ルール

## UIデザイン

UIルールは DESIGN.md に従うこと。

- フォント・カラー・ボタン形状・カード・スペーシングはすべて DESIGN.md を参照する
- DESIGN.md の「Reflexでの実装方針」セクションはこのプロジェクトには適用しない（Smart CarはHTML/CSS/JSのため）

## 技術スタック

- フロントエンド: HTML/CSS/JavaScript（index.html 単一ファイル）
- バックエンド: Google Apps Script（Code.gs）
- ホスティング: GitHub Pages（フロントエンド）、GAS（バックエンド）

## 開発ルール

- GASへの fetch は `Content-Type: text/plain` を使うこと（application/json だとCORSエラー）
- デプロイ確認用タイムスタンプ: タイトル横に `MM/DD-X` 形式で表示（本番安定後に削除）
