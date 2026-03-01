// ============================================================
// Smart Car 運転日誌システム - Google Apps Script
// ============================================================
// 【デプロイ設定】
//   種類             : ウェブアプリ
//   次のユーザーとして実行 : 自分（スプレッドシートオーナー）
//   アクセスできるユーザー : 全員（匿名を含む）
//
// 【列構成】
//   A(1): ID
//   B(2): 乗車日時
//   C(3): 乗車地(緯度)
//   D(4): 乗車地(経度)
//   E(5): 乗車地(住所)
//   F(6): 乗車メーター写真URL
//   G(7): OCR生データ(乗車)
//   H(8): 開始メーター値
//   I(9): 降車日時
//   J(10): 降車地(緯度)
//   K(11): 降車地(経度)
//   L(12): 降車地(住所)
//   M(13): 降車メーター写真URL
//   N(14): OCR生データ(降車)
//   O(15): 終了メーター値
//   P(16): 業務目的
//   Q(17): 走行距離(km)
//   R(18): ステータス
//   S(19): 作成日時
//
// 【初回手順】
//   1. このスクリプトを Google スプレッドシートのコンテナスクリプトとして貼り付ける
//   2. setupSheets() を一度だけ実行してシートとフォルダを初期化する
//   3. 「設定」シートの運転者名・車両情報・単価を入力する
//   4. 「設定」シートの B7 に Gemini API キーを入力する（Google AI Studio で取得）
//   5. ウェブアプリとしてデプロイしてURLを取得する
//   6. 「設定」シートの認証トークン（B6）をアプリに設定する
//
// 【既存環境へのアップデート手順】
//   1. Code.gs を貼り替えて保存・再デプロイ
//   2. migrateColumnOrder() を実行（既存データの列移動・1回だけ）
//   3. applyJournalFormat() を実行（書式・パディング適用）
//   ※ Sheets Advanced Service の有効化が必要（パディング機能）
//     GASエディタ左サイドバー「サービス」→「Google Sheets API」→「追加」
// ============================================================

const JOURNAL_SHEET = '運転日誌';
const LOG_SHEET     = '編集ログ';
const CONFIG_SHEET  = '設定';
const FOLDER_NAME   = 'SmartCar_写真';

// ============================================================
// エントリーポイント
// ============================================================

function doGet(e) {
  try {
    const action = e.parameter.action;

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
// ============================================================

function getStatus_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(JOURNAL_SHEET);
  const data  = sheet.getDataRange().getValues();

  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][17] === 'open') {  // R(18): ステータス
      return jsonResponse_({
        success:       true,
        hasOpenTrip:   true,
        tripId:        data[i][0],  // A: ID
        startDatetime: data[i][1],  // B: 乗車日時
        startAddress:  data[i][4]   // E: 乗車地住所
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

  const lastRow = sheet.getLastRow();
  const id = lastRow > 1 ? Number(sheet.getRange(lastRow, 1).getValue()) + 1 : 1;

  const photoUrl = data.photo
    ? savePhotoToDrive_(data.photo, 'start_' + id + '_' + Date.now() + '.jpg')
    : '';

  sheet.appendRow([
    id,                      // A(1) : ID
    new Date(data.datetime), // B(2) : 乗車日時
    data.lat     || '',      // C(3) : 乗車地（緯度）
    data.lon     || '',      // D(4) : 乗車地（経度）
    data.address || '',      // E(5) : 乗車地（住所）
    photoUrl,                // F(6) : 乗車メーター写真URL
    '',                      // G(7) : OCR生データ（乗車）
    '',                      // H(8) : 開始メーター値（OCRバッチで自動入力）
    '', '', '', '',          // I-L(9-12): 降車日時・緯度・経度・住所
    '',                      // M(13): 降車メーター写真URL
    '',                      // N(14): OCR生データ（降車）
    '',                      // O(15): 終了メーター値（OCRバッチで自動入力）
    data.purpose || '',      // P(16): 業務目的
    '',                      // Q(17): 走行距離（数式で自動計算）
    'open',                  // R(18): ステータス
    new Date().toISOString() // S(19): 作成日時
  ]);

  // Q列に走行距離の自動計算式を設定（H・O列が埋まると自動更新）
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, 17).setFormula(
    '=IF(AND(H' + newRow + '<>"",O' + newRow + '<>""),O' + newRow + '-H' + newRow + ',"")'
  );

  return jsonResponse_({ success: true, tripId: id });
}

// ============================================================
// 降車記録（POST { type:'end', tripId:N, ... }）
// ============================================================

function endTrip_(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const allData = sheet.getDataRange().getValues();

  let targetRow = -1;

  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][0]) === String(data.tripId)) {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow === -1) {
    return jsonResponse_({ success: false, error: '指定されたトリップが見つかりません (ID: ' + data.tripId + ')' });
  }

  const photoUrl = data.photo
    ? savePhotoToDrive_(data.photo, 'end_' + data.tripId + '_' + Date.now() + '.jpg')
    : '';

  sheet.getRange(targetRow, 9).setValue(new Date(data.datetime)); // I(9) : 降車日時
  sheet.getRange(targetRow, 10).setValue(data.lat     || '');     // J(10): 降車地（緯度）
  sheet.getRange(targetRow, 11).setValue(data.lon     || '');     // K(11): 降車地（経度）
  sheet.getRange(targetRow, 12).setValue(data.address || '');     // L(12): 降車地（住所）
  sheet.getRange(targetRow, 13).setValue(photoUrl);               // M(13): 降車メーター写真URL
  sheet.getRange(targetRow, 18).setValue('closed');               // R(18): ステータス

  return jsonResponse_({ success: true });
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

  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return file.getUrl();
}

// ============================================================
// OCRバッチ処理（時間トリガーで自動実行 or 手動実行）
// 未処理の写真（H列またはO列が空）をまとめてOCR処理する
// ============================================================

function processOcrBatch() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const sheet  = ss.getSheetByName(JOURNAL_SHEET);
  const config = ss.getSheetByName(CONFIG_SHEET);
  const apiKey = String(config.getRange('B7').getValue()).trim();

  if (!apiKey || apiKey === '（Google AI StudioからコピーしてB7に貼り付け）') {
    Logger.log('[OCR] Gemini APIキーが設定されていません（設定シート B7）');
    return;
  }

  const allData = sheet.getDataRange().getValues();
  let processed = 0;

  for (let i = 1; i < allData.length; i++) {
    const row           = allData[i];
    const rowNum        = i + 1;
    const startPhotoUrl = String(row[5]  || '');  // F(6) : 乗車メーター写真URL
    const endPhotoUrl   = String(row[12] || '');  // M(13): 降車メーター写真URL
    const startMeter    = row[7];                  // H(8) : 開始メーター値
    const endMeter      = row[14];                 // O(15): 終了メーター値

    // 乗車写真あり・H列空 → OCR
    if (startPhotoUrl && startMeter === '') {
      Logger.log('[OCR] 行' + rowNum + ' 乗車写真を処理中...');
      const result = ocrPhotoFromDrive_(startPhotoUrl, apiKey);
      // G列: 数値が取れた場合は数値として保存（カンマ書式が効く）、失敗時はテキスト
      sheet.getRange(rowNum, 7).setValue(result.value !== null ? result.value : result.rawText);
      if (result.value !== null) {
        sheet.getRange(rowNum, 8).setValue(result.value);  // H(8): 開始メーター値
        Logger.log('[OCR] 行' + rowNum + ' 乗車メーター = ' + result.value);
      } else {
        Logger.log('[OCR] 行' + rowNum + ' 乗車メーター 読取不可: ' + result.rawText);
      }
      processed++;
      Utilities.sleep(600);
    }

    // 降車写真あり・O列空 → OCR
    if (endPhotoUrl && endMeter === '') {
      Logger.log('[OCR] 行' + rowNum + ' 降車写真を処理中...');
      const result = ocrPhotoFromDrive_(endPhotoUrl, apiKey);
      // N列: 数値が取れた場合は数値として保存
      sheet.getRange(rowNum, 14).setValue(result.value !== null ? result.value : result.rawText);
      if (result.value !== null) {
        sheet.getRange(rowNum, 15).setValue(result.value);  // O(15): 終了メーター値
        Logger.log('[OCR] 行' + rowNum + ' 降車メーター = ' + result.value);
      } else {
        Logger.log('[OCR] 行' + rowNum + ' 降車メーター 読取不可: ' + result.rawText);
      }
      processed++;
      Utilities.sleep(600);
    }
  }

  Logger.log('[OCR] 処理完了: ' + processed + '件');
}

// ============================================================
// DriveのURLから画像を取得してOCR
// ============================================================

function ocrPhotoFromDrive_(driveUrl, apiKey) {
  try {
    const match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) {
      return { rawText: 'URLからファイルIDを取得できませんでした: ' + driveUrl, value: null };
    }

    const fileId = match[1];
    const file   = DriveApp.getFileById(fileId);
    const blob   = file.getBlob();
    const base64 = Utilities.base64Encode(blob.getBytes());

    return ocrImageGemini_(base64, apiKey);
  } catch(e) {
    return { rawText: 'エラー: ' + e.message, value: null };
  }
}

// ============================================================
// Gemini Vision API でOCR実行
// 返り値: { rawText: 'Geminiの生レスポンス', value: 数値 or null }
// ============================================================

function ocrImageGemini_(base64Data, apiKey) {
  const url  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        {
          text: 'この画像に写っているオドメーター（走行距離計）の数値を読み取ってください。数字のみを返してください。単位（km）は不要です。カンマや空白は除いた数字だけを返してください。読み取れない場合は「読取不可」とだけ返してください。'
        },
        {
          inline_data: {
            mime_type: 'image/jpeg',
            data: base64Data
          }
        }
      ]
    }]
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify(body),
      muteHttpExceptions: true
    });

    const json    = JSON.parse(response.getContentText());
    const rawText = (json.candidates &&
                     json.candidates[0] &&
                     json.candidates[0].content &&
                     json.candidates[0].content.parts &&
                     json.candidates[0].content.parts[0] &&
                     json.candidates[0].content.parts[0].text)
                    ? json.candidates[0].content.parts[0].text.trim()
                    : 'レスポンス解析エラー: ' + response.getContentText().substring(0, 200);

    const cleaned = rawText.replace(/[,，\s　km]/g, '');
    const value   = /^\d+$/.test(cleaned) ? Number(cleaned) : null;

    return { rawText, value };
  } catch(e) {
    return { rawText: 'API呼び出しエラー: ' + e.message, value: null };
  }
}

// ============================================================
// データ修正（編集ログ付き）
// POST { type:'edit', tripId:N, field:'startOdometer', newValue:'...', reason:'...' }
// ============================================================

function editRecord_(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const allData = sheet.getDataRange().getValues();

  const FIELD_COL = {
    startOdometer:  8,   // H: 開始メーター値
    endOdometer:    15,  // O: 終了メーター値
    startAddress:   5,   // E: 乗車地住所
    endAddress:     12,  // L: 降車地住所
    purpose:        16   // P: 業務目的
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
// 編集ログ記録
// ============================================================

function logEdit_(tripId, field, oldValue, newValue, reason) {
  const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  logSheet.appendRow([
    new Date().toISOString(),
    tripId,
    field,
    oldValue,
    newValue,
    reason
  ]);
}

// ============================================================
// 月次PDFレポート生成
// ============================================================

function generateMonthlyPDF_(year, month) {
  if (!year || !month) {
    const now = new Date();
    month = now.getMonth();
    year  = now.getFullYear();
    if (month === 0) { month = 12; year--; }
  }
  year  = Number(year);
  month = Number(month);

  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const config  = ss.getSheetByName(CONFIG_SHEET);
  const allData = sheet.getDataRange().getValues();

  const monthData = allData.slice(1).filter(row => {
    if (!row[1]) return false;
    const d = new Date(row[1]);
    return d.getFullYear() === year
        && (d.getMonth() + 1) === month
        && row[17] === 'closed';  // R(18)
  });

  if (monthData.length === 0) {
    return jsonResponse_({ success: false, error: year + '年' + month + '月のデータがありません' });
  }

  const driverName  = config.getRange('B2').getValue();
  const vehicleInfo = config.getRange('B3').getValue();
  const unitPrice   = Number(config.getRange('B4').getValue());

  const totalDistance = monthData.reduce((sum, row) => sum + Number(row[16] || 0), 0);  // Q(17)
  const totalAmount   = totalDistance * unitPrice;

  const docTitle = '運転日誌_' + year + '年' + month + '月_' + driverName;
  const doc      = DocumentApp.create(docTitle);
  const body     = doc.getBody();

  body.appendParagraph('業務用車両運転日誌')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1)
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  body.appendParagraph(
    year + '年' + month + '月分　運転者：' + driverName + '　車両：' + vehicleInfo
  ).setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  body.appendParagraph('');

  const headers = ['日付', '乗車地', '降車地', '開始(km)', '終了(km)', '距離(km)', '業務目的'];
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
      row[4]  || (row[2]  + ', ' + row[3]),   // E(5): 乗車住所
      row[11] || (row[9]  + ', ' + row[10]),   // L(12): 降車住所
      String(row[7]  || ''),                   // H(8) : 開始メーター
      String(row[14] || ''),                   // O(15): 終了メーター
      String(row[16] || ''),                   // Q(17): 走行距離
      String(row[15] || '')                    // P(16): 業務目的
    ].forEach(val => tr.appendTableCell(val));
  });

  body.appendParagraph('');
  body.appendParagraph('合計走行距離：' + totalDistance + ' km')
      .editAsText().setBold(true);
  body.appendParagraph(
    '経費合計：' + totalAmount.toLocaleString('ja-JP') + ' 円'
    + '（' + unitPrice + '円/km × ' + totalDistance + 'km）'
  ).editAsText().setBold(true);

  doc.saveAndClose();

  const folderId = config.getRange('B5').getValue();
  const folder   = DriveApp.getFolderById(folderId);
  const docFile  = DriveApp.getFileById(doc.getId());
  const pdfBlob  = docFile.getAs('application/pdf').setName(docTitle + '.pdf');
  const pdfFile  = folder.createFile(pdfBlob);

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
// 月次自動トリガー（毎月1日 9:00）
// ============================================================

function monthlyAutoReport() {
  const now   = new Date();
  let   month = now.getMonth();
  let   year  = now.getFullYear();
  if (month === 0) { month = 12; year--; }
  generateMonthlyPDF_(year, month);
}

// ============================================================
// 初期セットアップ（最初に1回だけ実行）
// ============================================================

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let journalSheet = ss.getSheetByName(JOURNAL_SHEET);
  if (!journalSheet) journalSheet = ss.insertSheet(JOURNAL_SHEET);
  journalSheet.clearContents();
  journalSheet.getRange(1, 1, 1, 19).setValues([[
    'ID', '乗車日時', '乗車地(緯度)', '乗車地(経度)', '乗車地(住所)',
    '乗車メーター写真URL', 'OCR生データ(乗車)', '開始メーター値',
    '降車日時', '降車地(緯度)', '降車地(経度)', '降車地(住所)',
    '降車メーター写真URL', 'OCR生データ(降車)', '終了メーター値',
    '業務目的', '走行距離(km)', 'ステータス', '作成日時'
  ]]);
  journalSheet.setFrozenRows(1);
  journalSheet.getRange(1, 1, 1, 19).setBackground('#e8f0fe').setFontWeight('bold');

  let logSheet = ss.getSheetByName(LOG_SHEET);
  if (!logSheet) logSheet = ss.insertSheet(LOG_SHEET);
  logSheet.clearContents();
  logSheet.getRange(1, 1, 1, 6).setValues([[
    '日時', '対象ID', '変更フィールド', '変更前の値', '変更後の値', '理由'
  ]]);
  logSheet.setFrozenRows(1);
  logSheet.getRange(1, 1, 1, 6).setBackground('#fce8e6').setFontWeight('bold');

  let configSheet = ss.getSheetByName(CONFIG_SHEET);
  if (!configSheet) configSheet = ss.insertSheet(CONFIG_SHEET);
  configSheet.clearContents();
  configSheet.getRange('A1:B7').setValues([
    ['設定項目',                              '値'],
    ['運転者名',                              '（入力してください）'],
    ['車両情報（例：トヨタ プリウス ABC-1234）', '（入力してください）'],
    ['単価（円/km）',                          15],
    ['DriveフォルダID',                        '（自動設定）'],
    ['認証トークン',                            generateToken_()],
    ['Gemini APIキー',                         '（Google AI StudioからコピーしてB7に貼り付け）']
  ]);
  configSheet.getRange('A1:B1').setFontWeight('bold').setBackground('#e8f0fe');
  configSheet.setColumnWidth(1, 320);
  configSheet.setColumnWidth(2, 380);

  const folder = DriveApp.createFolder(FOLDER_NAME);
  configSheet.getRange('B5').setValue(folder.getId());

  const existingTriggers = ScriptApp.getProjectTriggers();

  const alreadyHasMonthly = existingTriggers.some(t => t.getHandlerFunction() === 'monthlyAutoReport');
  if (!alreadyHasMonthly) {
    ScriptApp.newTrigger('monthlyAutoReport')
      .timeBased().onMonthDay(1).atHour(9).create();
  }

  const alreadyHasOcr = existingTriggers.some(t => t.getHandlerFunction() === 'processOcrBatch');
  if (!alreadyHasOcr) {
    ScriptApp.newTrigger('processOcrBatch')
      .timeBased().everyDays(1).atHour(4).create();
  }

  SpreadsheetApp.getUi().alert(
    '✅ セットアップ完了！\n\n' +
    '次の手順を実施してください：\n\n' +
    '1. 「設定」シートの B2〜B4 を入力\n' +
    '2. 「設定」シートの B7 に Gemini APIキーを入力\n' +
    '3. 認証トークン（B6）をアプリにコピー\n' +
    '4. ウェブアプリとしてデプロイ'
  );
}

// ============================================================
// 既存データの列順序を新レイアウトに移行（1回だけ実行）
// 旧: F=開始メーター, H=乗車写真, M=終了メーター, O=降車写真, P=走行距離, Q=業務目的
// 新: F=乗車写真, H=開始メーター, M=降車写真, O=終了メーター, P=業務目的, Q=走行距離
// ============================================================

function migrateColumnOrder() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert('データ行がありません。');
    return;
  }

  const numRows = lastRow - 1;

  // 旧データを一括読み込み
  const oldF = sheet.getRange(2, 6,  numRows, 1).getValues();  // 旧F: 開始メーター
  const oldH = sheet.getRange(2, 8,  numRows, 1).getValues();  // 旧H: 乗車写真URL
  const oldM = sheet.getRange(2, 13, numRows, 1).getValues();  // 旧M: 終了メーター
  const oldO = sheet.getRange(2, 15, numRows, 1).getValues();  // 旧O: 降車写真URL
  const oldQ = sheet.getRange(2, 17, numRows, 1).getValues();  // 旧Q: 業務目的

  // 新レイアウトに書き込み
  sheet.getRange(2, 6,  numRows, 1).setValues(oldH);  // 新F: 乗車写真URL
  sheet.getRange(2, 8,  numRows, 1).setValues(oldF);  // 新H: 開始メーター
  sheet.getRange(2, 13, numRows, 1).setValues(oldO);  // 新M: 降車写真URL
  sheet.getRange(2, 15, numRows, 1).setValues(oldM);  // 新O: 終了メーター
  sheet.getRange(2, 16, numRows, 1).setValues(oldQ);  // 新P: 業務目的

  // Q列: 走行距離を数式で再設定
  for (let r = 2; r <= lastRow; r++) {
    const i          = r - 2;
    const hasStart   = oldF[i][0] !== '';
    const hasEnd     = oldM[i][0] !== '';
    if (hasStart && hasEnd) {
      sheet.getRange(r, 17).setFormula(
        '=IF(AND(H' + r + '<>"",O' + r + '<>""),O' + r + '-H' + r + ',"")'
      );
    } else {
      sheet.getRange(r, 17).setValue('');
    }
  }

  // ヘッダー行を更新
  sheet.getRange(1, 1, 1, 19).setValues([[
    'ID', '乗車日時', '乗車地(緯度)', '乗車地(経度)', '乗車地(住所)',
    '乗車メーター写真URL', 'OCR生データ(乗車)', '開始メーター値',
    '降車日時', '降車地(緯度)', '降車地(経度)', '降車地(住所)',
    '降車メーター写真URL', 'OCR生データ(降車)', '終了メーター値',
    '業務目的', '走行距離(km)', 'ステータス', '作成日時'
  ]]);

  SpreadsheetApp.getUi().alert(
    '✅ 列の並び替え完了！（' + numRows + '行を変換）\n\n' +
    '次に applyJournalFormat を実行してください。'
  );
}

// ============================================================
// 利用可能な Gemini モデル一覧を確認（デバッグ用）
// ============================================================

function listGeminiModels() {
  const config = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET);
  const apiKey = String(config.getRange('B7').getValue()).trim();
  const url    = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey;

  const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const json = JSON.parse(res.getContentText());

  if (json.models) {
    json.models.forEach(m => Logger.log(m.name + ' | ' + (m.displayName || '')));
  } else {
    Logger.log('エラー: ' + res.getContentText().substring(0, 500));
  }
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
  return Utilities.getUuid().replace(/-/g, '');
}

// ============================================================
// スプレッドシート書式設定 + セルパディング
// ※パディングには Sheets Advanced Service が必要
//   GASエディタ「サービス」→「Google Sheets API」→「追加」
// ============================================================

function applyJournalFormat() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const lastRow = sheet.getLastRow();
  const sheetId = sheet.getSheetId();

  // ヘッダー書式
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 36);
  sheet.getRange(1, 1, 1, 19)
    .setBackground('#2c5f8a')
    .setFontColor('#ffffff')
    .setFontWeight('normal')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  // 数値フォーマット（日付・メーター値）
  const formatRows = Math.min(Math.max(lastRow, 2), 1000);
  sheet.getRange(2, 2,  formatRows - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm'); // B
  sheet.getRange(2, 9,  formatRows - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm'); // I
  sheet.getRange(2, 7,  formatRows - 1, 1).setNumberFormat('#,##0');             // G
  sheet.getRange(2, 8,  formatRows - 1, 1).setNumberFormat('#,##0');             // H
  sheet.getRange(2, 14, formatRows - 1, 1).setNumberFormat('#,##0');             // N
  sheet.getRange(2, 15, formatRows - 1, 1).setNumberFormat('#,##0');             // O
  sheet.getRange(2, 17, formatRows - 1, 1).setNumberFormat('#,##0');             // Q

  const colWidths = [
     50,  // A : ID
    150,  // B : 乗車日時
     80,  // C : 乗車地(緯度)
     80,  // D : 乗車地(経度)
    200,  // E : 乗車地(住所)
    250,  // F : 乗車メーター写真URL
    120,  // G : OCR生データ(乗車)
    120,  // H : 開始メーター値
    150,  // I : 降車日時
     80,  // J : 降車地(緯度)
     80,  // K : 降車地(経度)
    200,  // L : 降車地(住所)
    250,  // M : 降車メーター写真URL
    120,  // N : OCR生データ(降車)
    120,  // O : 終了メーター値
    200,  // P : 業務目的
     90,  // Q : 走行距離(km)
     80,  // R : ステータス
    170   // S : 作成日時
  ];

  // 列幅・パディングを Sheets API で一括設定（1回のAPIコールに削減）
  try {
    const requests = [];

    // 列幅（updateDimensionProperties で一括）
    colWidths.forEach((w, i) => {
      requests.push({
        updateDimensionProperties: {
          range: {
            sheetId:    sheetId,
            dimension:  'COLUMNS',
            startIndex: i,
            endIndex:   i + 1
          },
          properties: { pixelSize: w },
          fields:     'pixelSize'
        }
      });
    });

    // セルパディング
    requests.push({
      repeatCell: {
        range: {
          sheetId:       sheetId,
          startRowIndex: 0,
          endRowIndex:   formatRows
        },
        cell: {
          userEnteredFormat: {
            padding: { top: 5, right: 10, bottom: 5, left: 10 }
          }
        },
        fields: 'userEnteredFormat.padding'
      }
    });

    Sheets.Spreadsheets.batchUpdate({ requests }, ss.getId());
    SpreadsheetApp.getUi().alert('✅ 書式設定・パディング適用完了！');
  } catch(e) {
    // Sheets Advanced Service 未設定の場合はフォールバック
    colWidths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    SpreadsheetApp.getUi().alert(
      '✅ 書式設定完了！\n\n' +
      '⚠️ 列幅・パディングは未適用です。\n' +
      'GASエディタ「サービス」→「Google Sheets API」を追加してから再実行してください。\nエラー: ' + e.message
    );
  }
}
