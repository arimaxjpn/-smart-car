// ============================================================
// Smart Car 運転日誌システム - Google Apps Script
// ============================================================
// 【デプロイ設定】
//   種類             : ウェブアプリ
//   次のユーザーとして実行 : 自分（スプレッドシートオーナー）
//   アクセスできるユーザー : 全員（匿名を含む）
//
// 【初回手順】
//   1. このスクリプトを Google スプレッドシートのコンテナスクリプトとして貼り付ける
//   2. setupSheets() を一度だけ実行してシートとフォルダを初期化する
//   3. 「設定」シートの運転者名・車両情報・単価を入力する
//   4. ウェブアプリとしてデプロイしてURLを取得する
//   5. 「設定」シートの認証トークン（B6）をiPhoneショートカットに設定する
// ============================================================

const JOURNAL_SHEET  = '運転日誌';
const LOG_SHEET      = '編集ログ';
const CONFIG_SHEET   = '設定';
const FOLDER_NAME    = 'SmartCar_写真';
const ODOMETER_GAP_THRESHOLD = 500; // km：この差を超えると連続性警告を出す

// ============================================================
// エントリーポイント
// ============================================================

function doGet(e) {
  try {
    const action = e.parameter.action;

    // アクションなし → PWAアプリを配信
    if (!action) {
      const tmpl = HtmlService.createTemplateFromFile('index');
      tmpl.gasUrl = ScriptApp.getService().getUrl();
      return tmpl.evaluate()
        .setTitle('Smart Car')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    const token = e.parameter.token;
    if (!validateToken_(token)) {
      return jsonResponse_({ success: false, error: '認証エラー' });
    }

    if (action === 'status') {
      return getStatus_();
    }

    return jsonResponse_({ success: false, error: '不明なアクション: ' + action });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (!validateToken_(data.token)) {
      return jsonResponse_({ success: false, error: '認証エラー' });
    }

    switch (data.type) {
      case 'start':  return startTrip_(data);
      case 'end':    return endTrip_(data);
      case 'ocr':    return runOcr_(data);
      case 'report': return generateMonthlyPDF_(data.year, data.month);
      case 'edit':   return editRecord_(data);
      default:
        return jsonResponse_({ success: false, error: '不明なタイプ: ' + data.type });
    }
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

// ============================================================
// 認証
// ============================================================

function validateToken_(token) {
  if (!token) return false;
  const config = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET);
  const storedToken = config.getRange('B6').getValue();
  return token === String(storedToken);
}

// ============================================================
// ステータス確認（GET ?action=status&token=XXX）
// オープン中のトリップがあるか返す
// ============================================================

function getStatus_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(JOURNAL_SHEET);
  const data  = sheet.getDataRange().getValues();

  // 最後の行から逆順に open を探す
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][17] === 'open') {  // R列: ステータス
      return jsonResponse_({
        success:        true,
        hasOpenTrip:    true,
        tripId:         data[i][0],   // A: ID
        odometer:       data[i][5],   // F: 開始メーター値
        startDatetime:  data[i][1],   // B: 乗車日時
        startAddress:   data[i][4]    // E: 乗車地住所
      });
    }
  }

  return jsonResponse_({ success: true, hasOpenTrip: false });
}

// ============================================================
// 乗車記録（POST { type:'start', ... }）
// ============================================================

function startTrip_(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(JOURNAL_SHEET);

  // 連番ID生成（既存データ最終行のID + 1、初回は1）
  const lastRow = sheet.getLastRow();
  const id = lastRow > 1 ? Number(sheet.getRange(lastRow, 1).getValue()) + 1 : 1;

  // 写真を Drive に保存
  const photoUrl = data.photo
    ? savePhotoToDrive_(data.photo, 'start_' + id + '_' + Date.now() + '.jpg')
    : '';

  sheet.appendRow([
    id,                          // A: ID
    new Date(data.datetime),     // B: 乗車日時
    data.lat,                    // C: 乗車地（緯度）
    data.lon,                    // D: 乗車地（経度）
    data.address  || '',         // E: 乗車地（住所）
    data.odometer,               // F: 開始メーター値
    data.ocrRaw   || '',         // G: OCR生データ（乗車）
    photoUrl,                    // H: 乗車メーター写真URL
    '', '', '', '',              // I-L: 降車日時・位置・住所
    '', '', '',                  // M-O: 終了メーター・OCR・写真
    '',                          // P: 走行距離（後で計算）
    data.purpose  || '',         // Q: 業務目的
    'open',                      // R: ステータス
    new Date().toISOString()     // S: 作成日時
  ]);

  return jsonResponse_({ success: true, tripId: id });
}

// ============================================================
// 降車記録（POST { type:'end', tripId:N, ... }）
// ============================================================

function endTrip_(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const allData = sheet.getDataRange().getValues();

  let targetRow      = -1;
  let startOdometer  = 0;
  let prevEndOdometer = 0;

  for (let i = 1; i < allData.length; i++) {
    // 直前に終了した行の終了メーター値を記録（連続性チェック用）
    if (allData[i][17] === 'closed') {
      prevEndOdometer = Number(allData[i][12]);  // M列
    }
    // 対象トリップを特定
    if (String(allData[i][0]) === String(data.tripId)) {
      targetRow     = i + 1;  // getRange は 1-indexed
      startOdometer = Number(allData[i][5]);  // F列
    }
  }

  if (targetRow === -1) {
    return jsonResponse_({ success: false, error: '指定されたトリップが見つかりません (ID: ' + data.tripId + ')' });
  }

  // 連続性チェック
  const warning = {};
  if (prevEndOdometer > 0) {
    const gap = Math.abs(startOdometer - prevEndOdometer);
    if (gap > ODOMETER_GAP_THRESHOLD) {
      warning.continuityAlert =
        '前回終了値(' + prevEndOdometer + 'km)と今回開始値(' + startOdometer + 'km)の差が' + gap + 'kmあります';
    }
  }

  // 写真を Drive に保存
  const photoUrl = data.photo
    ? savePhotoToDrive_(data.photo, 'end_' + data.tripId + '_' + Date.now() + '.jpg')
    : '';

  // 走行距離計算
  const distance = Number(data.odometer) - startOdometer;
  if (distance < 0) {
    return jsonResponse_({ success: false, error: '終了メーター値が開始値より小さいです' });
  }

  // 対象行を更新
  sheet.getRange(targetRow, 9).setValue(new Date(data.datetime)); // I: 降車日時
  sheet.getRange(targetRow, 10).setValue(data.lat);         // J: 降車地（緯度）
  sheet.getRange(targetRow, 11).setValue(data.lon);         // K: 降車地（経度）
  sheet.getRange(targetRow, 12).setValue(data.address || ''); // L: 降車地（住所）
  sheet.getRange(targetRow, 13).setValue(data.odometer);    // M: 終了メーター値
  sheet.getRange(targetRow, 14).setValue(data.ocrRaw || ''); // N: OCR生データ（降車）
  sheet.getRange(targetRow, 15).setValue(photoUrl);         // O: 降車メーター写真URL
  sheet.getRange(targetRow, 16).setValue(distance);         // P: 走行距離
  sheet.getRange(targetRow, 18).setValue('closed');         // R: ステータス

  return jsonResponse_({ success: true, distance: distance, odometer: startOdometer, ...warning });
}

// ============================================================
// OCR（Gemini Vision API でメーター値を読み取る）
// POST { type:'ocr', token:'...', photo:'base64...' }
// 事前に設定シートの B7 に Gemini API キーを入力すること
// API キー取得先: https://aistudio.google.com/
// ============================================================

function runOcr_(data) {
  if (!data.photo) {
    return jsonResponse_({ success: false, error: '写真がありません' });
  }
  try {
    const rawText  = ocrImageGemini_(data.photo);
    const odometer = parseOdometer_(rawText);
    return jsonResponse_({ success: true, rawText: rawText, odometer: odometer });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function ocrImageGemini_(base64Data) {
  const config = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET);
  const apiKey = config.getRange('B7').getValue();

  if (!apiKey || String(apiKey).trim() === '' || apiKey === '（入力してください）') {
    throw new Error('Gemini APIキーが未設定です。設定シートのB7に入力してください。');
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey;

  const payload = {
    contents: [{
      parts: [
        {
          text: 'この車載メーターの画像からODO（オドメーター）の数値をkm単位で読み取り、数字のみを返してください。例：73577'
        },
        {
          inline_data: { mime_type: 'image/jpeg', data: base64Data }
        }
      ]
    }]
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const json = JSON.parse(response.getContentText());

  if (json.error) {
    throw new Error('Gemini APIエラー: ' + json.error.message);
  }

  return json.candidates[0].content.parts[0].text.trim();
}

function parseOdometer_(text) {
  // Geminiは数字のみを返すはずだが、念のため4〜6桁の数字を抽出
  const cleaned = text.replace(/[,.\s\n]/g, '');
  const matches = cleaned.match(/\d{4,6}/g);
  if (!matches) return null;
  return Math.max(...matches.map(Number));
}

// ============================================================
// 写真を Google Drive に保存してURLを返す
// ============================================================

function savePhotoToDrive_(base64Data, filename) {
  const config   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET);
  const folderId = config.getRange('B5').getValue();

  if (!folderId || folderId === '（自動設定）') {
    throw new Error('DriveフォルダIDが設定されていません。setupSheets() を実行してください。');
  }

  const folder  = DriveApp.getFolderById(folderId);
  const decoded = Utilities.base64Decode(base64Data);
  const blob    = Utilities.newBlob(decoded, 'image/jpeg', filename);
  const file    = folder.createFile(blob);

  // リンクを知っている全員が閲覧可能（証憑として共有しやすくする）
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return file.getUrl();
}

// ============================================================
// データ修正（編集ログ付き）
// POST { type:'edit', tripId:N, field:'startOdometer', newValue:'...', reason:'...' }
// ============================================================

function editRecord_(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const allData = sheet.getDataRange().getValues();

  // フィールド名 → 列番号（1-indexed）のマップ
  const FIELD_COL = {
    startOdometer:  6,   // F
    endOdometer:    13,  // M
    startAddress:   5,   // E
    endAddress:     12,  // L
    purpose:        17   // Q
  };

  const col = FIELD_COL[data.field];
  if (!col) {
    return jsonResponse_({ success: false, error: '不明なフィールド: ' + data.field });
  }

  let targetRow = -1;
  let oldValue  = '';

  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][0]) === String(data.tripId)) {
      targetRow = i + 1;
      oldValue  = allData[i][col - 1];
      break;
    }
  }

  if (targetRow === -1) {
    return jsonResponse_({ success: false, error: 'レコードが見つかりません' });
  }

  sheet.getRange(targetRow, col).setValue(data.newValue);
  logEdit_(data.tripId, data.field, oldValue, data.newValue, data.reason || '');

  return jsonResponse_({ success: true });
}

// ============================================================
// 編集ログ記録（電子帳簿保存法：訂正・削除履歴の保存）
// ============================================================

function logEdit_(tripId, field, oldValue, newValue, reason) {
  const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  logSheet.appendRow([
    new Date().toISOString(),  // A: 日時
    tripId,                    // B: 対象ID
    field,                     // C: 変更フィールド
    oldValue,                  // D: 変更前
    newValue,                  // E: 変更後
    reason                     // F: 理由
  ]);
}

// ============================================================
// 月次PDFレポート生成
// POST { type:'report', year:2025, month:1 }  ← 省略時は前月
// ============================================================

function generateMonthlyPDF_(year, month) {
  // 引数未指定時は「前月」を対象にする
  if (!year || !month) {
    const now = new Date();
    month = now.getMonth();       // 0-indexed → 先月（1月なら0→12月）
    year  = now.getFullYear();
    if (month === 0) { month = 12; year--; }
  }
  year  = Number(year);
  month = Number(month);

  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const sheet  = ss.getSheetByName(JOURNAL_SHEET);
  const config = ss.getSheetByName(CONFIG_SHEET);
  const allData = sheet.getDataRange().getValues();

  // 対象月・終了済みのデータを抽出
  const monthData = allData.slice(1).filter(row => {
    if (!row[1]) return false;
    const d = new Date(row[1]);
    return d.getFullYear() === year
        && (d.getMonth() + 1) === month
        && row[17] === 'closed';
  });

  if (monthData.length === 0) {
    return jsonResponse_({ success: false, error: year + '年' + month + '月のデータがありません' });
  }

  // 設定値
  const driverName  = config.getRange('B2').getValue();
  const vehicleInfo = config.getRange('B3').getValue();
  const unitPrice   = Number(config.getRange('B4').getValue());

  // 集計
  const totalDistance = monthData.reduce((sum, row) => sum + Number(row[15] || 0), 0);
  const totalAmount   = totalDistance * unitPrice;

  // Google Document を一時作成してPDFに変換
  const docTitle = '運転日誌_' + year + '年' + month + '月_' + driverName;
  const doc      = DocumentApp.create(docTitle);
  const body     = doc.getBody();

  // ---- ヘッダー ----
  body.appendParagraph('業務用車両運転日誌')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1)
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  body.appendParagraph(
    year + '年' + month + '月分　運転者：' + driverName + '　車両：' + vehicleInfo
  ).setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  body.appendParagraph('');

  // ---- 明細表 ----
  const headers = ['日付', '乗車地', '降車地', '開始(km)', '終了(km)', '距離(km)', '業務目的・訪問先'];
  const table   = body.appendTable();
  const headerRow = table.appendTableRow();
  headers.forEach(h => {
    const cell = headerRow.appendTableCell(h);
    cell.setBackgroundColor('#4a86e8');
    cell.editAsText().setForegroundColor('#ffffff').setBold(true);
  });

  monthData.forEach(row => {
    const d       = new Date(row[1]);
    const dateStr = (d.getMonth() + 1) + '/' + d.getDate();
    const tr      = table.appendTableRow();
    [
      dateStr,
      row[4]  || (row[2]  + ', ' + row[3]),   // 乗車地住所 or 緯度・経度
      row[11] || (row[9]  + ', ' + row[10]),   // 降車地住所 or 緯度・経度
      String(row[5]  || ''),                   // 開始メーター
      String(row[12] || ''),                   // 終了メーター
      String(row[15] || ''),                   // 走行距離
      String(row[16] || '')                    // 業務目的
    ].forEach(val => tr.appendTableCell(val));
  });

  // ---- 合計 ----
  body.appendParagraph('');
  body.appendParagraph('合計走行距離：' + totalDistance + ' km')
      .editAsText().setBold(true);
  body.appendParagraph(
    '経費合計：' + totalAmount.toLocaleString('ja-JP') + ' 円'
    + '（' + unitPrice + '円/km × ' + totalDistance + 'km）'
  ).editAsText().setBold(true);

  doc.saveAndClose();

  // ---- PDF変換 → Drive保存 ----
  const folderId = config.getRange('B5').getValue();
  const folder   = DriveApp.getFolderById(folderId);
  const docFile  = DriveApp.getFileById(doc.getId());
  const pdfBlob  = docFile.getAs('application/pdf').setName(docTitle + '.pdf');
  const pdfFile  = folder.createFile(pdfBlob);

  // 元のDocを削除（PDFのみ保持）
  docFile.setTrashed(true);

  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return jsonResponse_({
    success:       true,
    pdfUrl:        pdfFile.getUrl(),
    totalDistance: totalDistance,
    totalAmount:   totalAmount,
    recordCount:   monthData.length
  });
}

// ============================================================
// 月次自動トリガー（毎月1日 9:00 に自動実行）
// setupSheets() でトリガーを登録済み
// ============================================================

function monthlyAutoReport() {
  const now   = new Date();
  let   month = now.getMonth();     // 0-indexed → 先月
  let   year  = now.getFullYear();
  if (month === 0) { month = 12; year--; }
  generateMonthlyPDF_(year, month);
}

// ============================================================
// 初期セットアップ（最初に1回だけ実行）
// ============================================================

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ---- 運転日誌シート ----
  let journalSheet = ss.getSheetByName(JOURNAL_SHEET);
  if (!journalSheet) journalSheet = ss.insertSheet(JOURNAL_SHEET);
  journalSheet.clearContents();
  journalSheet.getRange(1, 1, 1, 19).setValues([[
    'ID', '乗車日時', '乗車地(緯度)', '乗車地(経度)', '乗車地(住所)',
    '開始メーター値', 'OCR生データ(乗車)', '乗車メーター写真URL',
    '降車日時', '降車地(緯度)', '降車地(経度)', '降車地(住所)',
    '終了メーター値', 'OCR生データ(降車)', '降車メーター写真URL',
    '走行距離(km)', '業務目的・訪問先', 'ステータス', '作成日時'
  ]]);
  journalSheet.setFrozenRows(1);
  journalSheet.getRange(1, 1, 1, 19).setBackground('#e8f0fe').setFontWeight('bold');

  // ---- 編集ログシート ----
  let logSheet = ss.getSheetByName(LOG_SHEET);
  if (!logSheet) logSheet = ss.insertSheet(LOG_SHEET);
  logSheet.clearContents();
  logSheet.getRange(1, 1, 1, 6).setValues([[
    '日時', '対象ID', '変更フィールド', '変更前の値', '変更後の値', '理由'
  ]]);
  logSheet.setFrozenRows(1);
  logSheet.getRange(1, 1, 1, 6).setBackground('#fce8e6').setFontWeight('bold');

  // ---- 設定シート ----
  let configSheet = ss.getSheetByName(CONFIG_SHEET);
  if (!configSheet) configSheet = ss.insertSheet(CONFIG_SHEET);
  configSheet.clearContents();
  configSheet.getRange('A1:B6').setValues([
    ['設定項目',                              '値'],
    ['運転者名',                              '（入力してください）'],
    ['車両情報（例：トヨタ プリウス ABC-1234）', '（入力してください）'],
    ['単価（円/km）',                          15],
    ['DriveフォルダID',                        '（自動設定）'],
    ['認証トークン',                            generateToken_()]
  ]);
  configSheet.getRange('A1:B1').setFontWeight('bold').setBackground('#e8f0fe');
  configSheet.setColumnWidth(1, 320);
  configSheet.setColumnWidth(2, 380);

  // ---- Google Drive フォルダ自動作成 ----
  const folder = DriveApp.createFolder(FOLDER_NAME);
  configSheet.getRange('B5').setValue(folder.getId());

  // ---- 月次自動トリガー登録（重複防止チェック付き） ----
  const existingTriggers = ScriptApp.getProjectTriggers();
  const alreadyExists = existingTriggers.some(t => t.getHandlerFunction() === 'monthlyAutoReport');
  if (!alreadyExists) {
    ScriptApp.newTrigger('monthlyAutoReport')
      .timeBased()
      .onMonthDay(1)
      .atHour(9)
      .create();
  }

  SpreadsheetApp.getUi().alert(
    '✅ セットアップ完了！\n\n' +
    '次の手順を実施してください：\n\n' +
    '1. 「設定」シートの B2〜B4 を入力\n' +
    '   ・運転者名\n' +
    '   ・車両情報\n' +
    '   ・単価（円/km）\n\n' +
    '2. 認証トークン（B6 の値）をiPhoneショートカットにコピー\n\n' +
    '3. このスクリプトをウェブアプリとしてデプロイしてURLを取得\n' +
    '   デプロイ設定：\n' +
    '   ・実行ユーザー：自分\n' +
    '   ・アクセス：全員（匿名を含む）\n\n' +
    '4. デプロイURLとトークンをiPhoneショートカットに設定'
  );
}

// ============================================================
// ユーティリティ
// ============================================================

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function generateToken_() {
  // UUIDベースのランダムトークン（ハイフンなし32文字）
  return Utilities.getUuid().replace(/-/g, '');
}

// ============================================================
// スプレッドシート書式設定（初回セットアップ後に1回実行）
// データは消えません。何度実行しても安全です。
// ============================================================

function applyJournalFormat() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const lastRow = sheet.getLastRow();

  // ---- ヘッダー行 ----
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 36);
  sheet.getRange(1, 1, 1, 19)
    .setBackground('#2c5f8a')
    .setFontColor('#ffffff')
    .setFontWeight('normal')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  // ---- 列幅 ----
  const colWidths = [
     50,  // A: ID
    150,  // B: 乗車日時
     80,  // C: 乗車地(緯度)
     80,  // D: 乗車地(経度)
    200,  // E: 乗車地(住所)
    120,  // F: 開始メーター値
    130,  // G: OCR生データ(乗車)
    250,  // H: 乗車メーター写真URL
    150,  // I: 降車日時
     80,  // J: 降車地(緯度)
     80,  // K: 降車地(経度)
    200,  // L: 降車地(住所)
    120,  // M: 終了メーター値
    130,  // N: OCR生データ(降車)
    250,  // O: 降車メーター写真URL
     90,  // P: 走行距離(km)
    200,  // Q: 業務目的・訪問先
     80,  // R: ステータス
    170   // S: 作成日時
  ];
  colWidths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  // ---- 既存の日時文字列をDateオブジェクトに変換 ----
  if (lastRow > 1) {
    ['B', 'I'].forEach(col => {
      const range = sheet.getRange(col + '2:' + col + lastRow);
      const vals  = range.getValues();
      const converted = vals.map(row => {
        if (!row[0]) return [''];
        const d = new Date(row[0]);
        return [isNaN(d.getTime()) ? row[0] : d];
      });
      range.setValues(converted);
    });
  }

  // ---- 日時・数値フォーマット（データがある行のみ、最大1000行） ----
  const formatRows = Math.min(Math.max(lastRow, 2), 1000);
  sheet.getRange(2, 2,  formatRows - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm'); // B
  sheet.getRange(2, 9,  formatRows - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm'); // I
  sheet.getRange(2, 6,  formatRows - 1, 1).setNumberFormat('#,##0');             // F
  sheet.getRange(2, 13, formatRows - 1, 1).setNumberFormat('#,##0');             // M
  sheet.getRange(2, 16, formatRows - 1, 1).setNumberFormat('#,##0');             // P

  SpreadsheetApp.getUi().alert('✅ 書式設定を適用しました！');
}
