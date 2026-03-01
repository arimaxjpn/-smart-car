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
//   5. 「設定」シートの認証トークン（B6）をアプリに設定する
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
    if (data[i][17] === 'open') {  // R列: ステータス
      return jsonResponse_({
        success:       true,
        hasOpenTrip:   true,
        tripId:        data[i][0],   // A: ID
        startDatetime: data[i][1],   // B: 乗車日時
        startAddress:  data[i][4]    // E: 乗車地住所
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
    id,                      // A: ID
    new Date(data.datetime), // B: 乗車日時
    data.lat     || '',      // C: 乗車地（緯度）
    data.lon     || '',      // D: 乗車地（経度）
    data.address || '',      // E: 乗車地（住所）
    '',                      // F: 開始メーター値（第二システムで入力）
    '',                      // G: OCR生データ（乗車）（第二システムで入力）
    photoUrl,                // H: 乗車メーター写真URL
    '', '', '', '',          // I-L: 降車日時・位置・住所
    '', '', '',              // M-O: 終了メーター・OCR・写真
    '',                      // P: 走行距離（第二システムで計算）
    data.purpose || '',      // Q: 業務目的
    'open',                  // R: ステータス
    new Date().toISOString() // S: 作成日時
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

  let targetRow = -1;

  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][0]) === String(data.tripId)) {
      targetRow = i + 1;  // getRange は 1-indexed
      break;
    }
  }

  if (targetRow === -1) {
    return jsonResponse_({ success: false, error: '指定されたトリップが見つかりません (ID: ' + data.tripId + ')' });
  }

  const photoUrl = data.photo
    ? savePhotoToDrive_(data.photo, 'end_' + data.tripId + '_' + Date.now() + '.jpg')
    : '';

  sheet.getRange(targetRow, 9).setValue(new Date(data.datetime)); // I: 降車日時
  sheet.getRange(targetRow, 10).setValue(data.lat     || '');     // J: 降車地（緯度）
  sheet.getRange(targetRow, 11).setValue(data.lon     || '');     // K: 降車地（経度）
  sheet.getRange(targetRow, 12).setValue(data.address || '');     // L: 降車地（住所）
  sheet.getRange(targetRow, 15).setValue(photoUrl);               // O: 降車メーター写真URL
  sheet.getRange(targetRow, 18).setValue('closed');               // R: ステータス

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
// データ修正（編集ログ付き）
// POST { type:'edit', tripId:N, field:'startOdometer', newValue:'...', reason:'...' }
// ============================================================

function editRecord_(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const allData = sheet.getDataRange().getValues();

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
// POST { type:'report', year:2025, month:1 }
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

  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const sheet  = ss.getSheetByName(JOURNAL_SHEET);
  const config = ss.getSheetByName(CONFIG_SHEET);
  const allData = sheet.getDataRange().getValues();

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

  const driverName  = config.getRange('B2').getValue();
  const vehicleInfo = config.getRange('B3').getValue();
  const unitPrice   = Number(config.getRange('B4').getValue());

  const totalDistance = monthData.reduce((sum, row) => sum + Number(row[15] || 0), 0);
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
      row[4]  || (row[2]  + ', ' + row[3]),
      row[11] || (row[9]  + ', ' + row[10]),
      String(row[5]  || ''),
      String(row[12] || ''),
      String(row[15] || ''),
      String(row[16] || '')
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
    '開始メーター値', 'OCR生データ(乗車)', '乗車メーター写真URL',
    '降車日時', '降車地(緯度)', '降車地(経度)', '降車地(住所)',
    '終了メーター値', 'OCR生データ(降車)', '降車メーター写真URL',
    '走行距離(km)', '業務目的・訪問先', 'ステータス', '作成日時'
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

  const folder = DriveApp.createFolder(FOLDER_NAME);
  configSheet.getRange('B5').setValue(folder.getId());

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
    '2. 認証トークン（B6 の値）をアプリにコピー\n\n' +
    '3. このスクリプトをウェブアプリとしてデプロイ'
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
  return Utilities.getUuid().replace(/-/g, '');
}

// ============================================================
// スプレッドシート書式設定
// ============================================================

function applyJournalFormat() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const lastRow = sheet.getLastRow();

  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 36);
  sheet.getRange(1, 1, 1, 19)
    .setBackground('#2c5f8a')
    .setFontColor('#ffffff')
    .setFontWeight('normal')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

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

  const formatRows = Math.min(Math.max(lastRow, 2), 1000);
  sheet.getRange(2, 2,  formatRows - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm'); // B
  sheet.getRange(2, 9,  formatRows - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm'); // I
  sheet.getRange(2, 6,  formatRows - 1, 1).setNumberFormat('#,##0');             // F
  sheet.getRange(2, 13, formatRows - 1, 1).setNumberFormat('#,##0');             // M
  sheet.getRange(2, 16, formatRows - 1, 1).setNumberFormat('#,##0');             // P

  SpreadsheetApp.getUi().alert('✅ 書式設定を適用しました！');
}
