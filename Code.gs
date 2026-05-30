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
//   C(3): 乗車緯度
//   D(4): 乗車経度
//   E(5): 乗車住所
//   F(6): 乗車時写真
//   G(7): 乗車OCR
//   H(8): 開始値
//   I(9): 降車日時
//   J(10): 降車緯度
//   K(11): 降車経度
//   L(12): 降車住所
//   M(13): 降車時写真
//   N(14): 降車OCR
//   O(15): 終了値
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
const _VERSION      = 'v0.6';

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
      case 'start':      return startTrip_(data);
      case 'end':        return endTrip_(data);
      case 'report':     return generateMonthlyPDF_(data.year, data.month);
      case 'edit':       return editRecord_(data);
      case 'listMonths': return listArchivableMonths_();
      case 'createPack': return jsonResponse_(createMonthlyPackCore_(Number(data.year), Number(data.month)));
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

  // 重複防止：直近1分以内に同じ住所の乗車記録があれば弾く
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const lastTime = sheet.getRange(lastRow, 2).getValue();  // B: 乗車日時
    const lastAddr = sheet.getRange(lastRow, 5).getValue();  // E: 乗車住所
    if (lastTime instanceof Date) {
      const diffSec = (new Date(data.datetime) - lastTime) / 1000;
      if (diffSec >= 0 && diffSec < 60 && lastAddr === (data.address || '')) {
        return jsonResponse_({ success: true, tripId: Number(sheet.getRange(lastRow, 1).getValue()), duplicate: true });
      }
    }
  }

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

  // 新しい行に書式を自動適用
  formatNewRow_(sheet, newRow);

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

  // 重複防止：既に closed なら処理済みとみなす
  if (allData[targetRow - 1][17] === 'closed') {
    return jsonResponse_({ success: true, duplicate: true });
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
  const apiKey = getGeminiApiKey_();
  if (!apiKey) return;

  const allData = sheet.getDataRange().getValues();
  let processed = 0;

  for (let i = 1; i < allData.length; i++) {
    const row           = allData[i];
    const rowNum        = i + 1;
    const startPhotoUrl = String(row[5]  || '');  // F(6) : 乗車メーター写真URL
    const endPhotoUrl   = String(row[12] || '');  // M(13): 降車メーター写真URL
    const startMeter    = row[7];                  // H(8) : 開始メーター値
    const endMeter      = row[14];                 // O(15): 終了メーター値
    const startOcrRaw   = row[6]  || '';           // G(7) : 乗車OCR生データ
    const endOcrRaw     = row[13] || '';           // N(14): 降車OCR生データ

    if (isOcrPending_(startPhotoUrl, startMeter, startOcrRaw)) {
      Logger.log('[OCR] 行' + rowNum + ' 乗車写真を処理中...');
      runOcrForRow_(sheet, rowNum, startPhotoUrl, 'start', apiKey);
      processed++;
      Utilities.sleep(600);
    }

    if (isOcrPending_(endPhotoUrl, endMeter, endOcrRaw)) {
      Logger.log('[OCR] 行' + rowNum + ' 降車写真を処理中...');
      runOcrForRow_(sheet, rowNum, endPhotoUrl, 'end', apiKey);
      processed++;
      Utilities.sleep(600);
    }
  }

  Logger.log('[OCR] 処理完了: ' + processed + '件');
}

function forceReprocessOcr() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(JOURNAL_SHEET);
  const data = sheet.getDataRange().getValues();
  const apiKey = getGeminiApiKey_();
  if (!apiKey) return;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const startPhotoUrl = String(row[5] || '');
    const startMeter = row[7];
    const endPhotoUrl = String(row[12] || '');
    const endMeter = row[14];
    const rowNum = i + 1;

    if (String(startPhotoUrl).trim() !== '' && parseNumberOrNull_(startMeter) === null) {
      Logger.log('[OCR] 強制再実行(乗車): 行' + rowNum);
      runOcrForRow_(sheet, rowNum, startPhotoUrl, 'start', apiKey);
      Utilities.sleep(600);
    }
    if (String(endPhotoUrl).trim() !== '' && parseNumberOrNull_(endMeter) === null) {
      Logger.log('[OCR] 強制再実行(降車): 行' + rowNum);
      runOcrForRow_(sheet, rowNum, endPhotoUrl, 'end', apiKey);
      Utilities.sleep(600);
    }
  }

  Logger.log('[OCR] forceReprocessOcr complete');
}

function getGeminiApiKey_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const config = ss.getSheetByName(CONFIG_SHEET);
  const apiKey = String(config.getRange('B7').getValue()).trim();

  if (!apiKey || apiKey === '（Google AI StudioからコピーしてB7に貼り付け）') {
    Logger.log('[OCR] Gemini APIキーが設定されていません（設定シート B7）');
    return '';
  }

  return apiKey;
}

function isOcrPending_(photoUrl, meterValue, ocrRawText) {
  if (String(photoUrl || '').trim() === '') return false;
  if (parseNumberOrNull_(meterValue) !== null) return false;

  const raw = String(ocrRawText || '').trim();
  return raw === '' || raw.startsWith('OCRエラー') || raw.startsWith('ERROR');
}

function runOcrForRow_(sheet, rowNum, photoUrl, kind, apiKey) {
  const isStart = kind === 'start';
  const rawCol = isStart ? 7 : 14;
  const meterCol = isStart ? 8 : 15;
  const label = isStart ? '乗車' : '降車';
  const result = ocrPhotoFromDrive_(photoUrl, apiKey);

  sheet.getRange(rowNum, rawCol).setValue(result.value !== null ? result.value : result.rawText);
  if (result.value !== null) {
    sheet.getRange(rowNum, meterCol).setValue(result.value);
    Logger.log('[OCR] 行' + rowNum + ' ' + label + 'メーター = ' + result.value);
  } else {
    Logger.log('[OCR] 行' + rowNum + ' ' + label + 'メーター 読取不可: ' + result.rawText);
  }

  return result;
}

// ============================================================
// DriveのURLから画像を取得してOCR
// ============================================================

function ocrPhotoFromDrive_(driveUrl, apiKey) {
  try {
    const match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) {
      return { rawText: formatOcrError_('URLからファイルIDを取得できませんでした: ' + driveUrl), value: null };
    }

    const fileId = match[1];
    const file   = DriveApp.getFileById(fileId);
    const blob   = file.getBlob();
    const base64 = Utilities.base64Encode(blob.getBytes());

    return ocrImageGemini_(base64, apiKey);
  } catch(e) {
    return { rawText: formatOcrError_(e.message), value: null };
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
                    : formatOcrError_('レスポンス解析エラー: ' + response.getContentText().substring(0, 200));

    const cleaned = rawText.replace(/[,，\s　km]/g, '');
    const value   = /^\d+$/.test(cleaned) ? Number(cleaned) : null;

    return { rawText, value };
  } catch(e) {
    return { rawText: formatOcrError_('API呼び出しエラー: ' + e.message), value: null };
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

  const reportData = collectMonthlyReportData_(allData.slice(1), year, month);
  const validRows = reportData.validRows;
  const reviewRows = reportData.reviewRows;

  if (validRows.length === 0 && reviewRows.length === 0) {
    return jsonResponse_({ success: false, error: year + '年' + month + '月のデータがありません' });
  }

  const driverName  = config.getRange('B2').getValue();
  const vehicleInfo = config.getRange('B3').getValue();
  const unitPrice   = Number(config.getRange('B4').getValue());

  const totalDistance = validRows.reduce((sum, item) => sum + item.distance, 0);
  const totalAmount   = totalDistance * unitPrice;
  const periodLabel = Utilities.formatString('%04d-%02d', year, month);
  const fileName = periodLabel + '_運転月報.pdf';
  const docTitle = periodLabel + '_運転月報';
  const doc      = DocumentApp.create(docTitle);
  const body     = doc.getBody();

  body.appendParagraph('業務用車両 月報')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1)
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  body.appendParagraph(
    year + '年' + month + '月分　運転者：' + driverName + '　車両：' + vehicleInfo
  ).setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  body.appendParagraph('判定基準: closed レコード / 降車日時ベース / 画像は月報に含めない')
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  body.appendParagraph('');

  appendMonthlyReportTable_(body, '月報対象一覧', validRows, false);

  if (reviewRows.length > 0) {
    body.appendParagraph('');
    appendMonthlyReportTable_(body, '要確認一覧', reviewRows, true);
    body.appendParagraph('要確認は合計件数・合計走行km・合計金額に含めていません。')
        .setForegroundColor('#b45f06');
  }

  body.appendParagraph('');
  body.appendParagraph('件数：' + validRows.length + '件')
      .editAsText().setBold(true);
  body.appendParagraph('合計走行km：' + formatNumberForPdf_(totalDistance) + ' km')
      .editAsText().setBold(true);
  body.appendParagraph(
    '合計金額：' + formatNumberForPdf_(totalAmount) + ' 円'
    + '（' + formatNumberForPdf_(unitPrice) + '円/km × ' + formatNumberForPdf_(totalDistance) + 'km）'
  ).editAsText().setBold(true);

  doc.saveAndClose();

  const folder   = getMonthlyReportFolder_(config);
  const docFile  = DriveApp.getFileById(doc.getId());
  trashExistingFilesByName_(folder, fileName);
  const pdfBlob  = docFile.getAs('application/pdf').setName(fileName);
  const pdfFile  = folder.createFile(pdfBlob);

  docFile.setTrashed(true);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return jsonResponse_({
    success:       true,
    pdfUrl:        pdfFile.getUrl(),
    folderUrl:     folder.getUrl(),
    totalDistance: totalDistance,
    totalAmount:   totalAmount,
    recordCount:   validRows.length,
    reviewCount:   reviewRows.length,
    fileName:      fileName
  });
}

function collectMonthlyReportData_(rows, year, month) {
  const validRows = [];
  const reviewRows = [];

  rows.forEach((row, index) => {
    if (row[17] !== 'closed' || !row[8]) return;

    const endDate = new Date(row[8]);
    if (isNaN(endDate.getTime())) return;
    if (endDate.getFullYear() !== year || (endDate.getMonth() + 1) !== month) return;

    const normalized = normalizeMonthlyRow_(row, index + 2);
    if (normalized.reviewReason) {
      reviewRows.push(normalized);
    } else {
      validRows.push(normalized);
    }
  });

  validRows.sort((a, b) => a.endDate - b.endDate);
  reviewRows.sort((a, b) => a.endDate - b.endDate);

  return { validRows, reviewRows };
}

function normalizeMonthlyRow_(row, rowNumber) {
  const startValue = parseNumberOrNull_(row[7]);
  const endValue = parseNumberOrNull_(row[14]);
  const distance = parseNumberOrNull_(row[16]);
  const computedDistance = startValue !== null && endValue !== null ? endValue - startValue : null;
  const reviewReasons = [];

  if (!row[8]) reviewReasons.push('降車日時なし');
  if (startValue === null) reviewReasons.push('開始値未確定');
  if (endValue === null) reviewReasons.push('終了値未確定');
  if (distance === null) reviewReasons.push('走行km未確定');
  if (startValue !== null && endValue !== null && endValue < startValue) reviewReasons.push('終了値が開始値未満');
  if (distance !== null && distance < 0) reviewReasons.push('走行kmがマイナス');
  if (distance !== null && distance > 500) reviewReasons.push('走行kmが500km超');
  if (distance !== null && computedDistance !== null && Math.abs(distance - computedDistance) > 0.001) {
    reviewReasons.push('走行kmと開始/終了値が不一致');
  }
  if (hasPendingOcr_(row[5], row[6], row[7])) reviewReasons.push('乗車OCR未確定');
  if (hasPendingOcr_(row[12], row[13], row[14])) reviewReasons.push('降車OCR未確定');

  return {
    rowNumber: rowNumber,
    endDate: new Date(row[8]),
    dateLabel: formatDateForPdf_(row[8]),
    startAddress: shortenAddressForPdf_(buildAddressLabel_(row[4], row[2], row[3])),
    endAddress: shortenAddressForPdf_(buildAddressLabel_(row[11], row[9], row[10])),
    startValue: startValue,
    endValue: endValue,
    distance: distance,
    purpose: String(row[15] || ''),
    reviewReason: reviewReasons.join(' / ')
  };
}

function appendMonthlyReportTable_(body, title, rows, includeReason) {
  body.appendParagraph(title)
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);

  const headers = ['日付', '乗車住所', '降車住所', '開始', '終了', '距離', '目的'];
  if (includeReason) headers.push('要確認');

  const table = body.appendTable();
  const headerRow = table.appendTableRow();
  headers.forEach(h => {
    const cell = headerRow.appendTableCell(h);
    cell.setBackgroundColor(includeReason ? '#b45f06' : '#4a86e8');
    cell.editAsText()
      .setForegroundColor('#ffffff')
      .setBold(true)
      .setFontFamily('Arial')
      .setFontSize(9);
    cell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  });
  setMonthlyReportColumnWidths_(table, includeReason);

  if (rows.length === 0) {
    const emptyRow = table.appendTableRow();
    appendBodyTableCell_(emptyRow, '対象なし');
    for (let i = 1; i < headers.length; i++) {
      appendBodyTableCell_(emptyRow, '');
    }
    return;
  }

  rows.forEach(item => {
    const tr = table.appendTableRow();
    appendBodyTableCell_(tr, item.dateLabel, 'CENTER', 9);
    appendBodyTableCell_(tr, item.startAddress, 'LEFT', 8);
    appendBodyTableCell_(tr, item.endAddress, 'LEFT', 8);
    appendBodyTableCell_(tr, formatMeterForPdf_(item.startValue), 'RIGHT', 8);
    appendBodyTableCell_(tr, formatMeterForPdf_(item.endValue), 'RIGHT', 8);
    appendBodyTableCell_(tr, formatNumberForPdf_(item.distance), 'RIGHT', 9);
    appendBodyTableCell_(tr, item.purpose, 'LEFT', 9);

    if (includeReason) {
      appendBodyTableCell_(tr, item.reviewReason, 'LEFT', 8);
    }
  });
}

function setMonthlyReportColumnWidths_(table, includeReason) {
  const widths = includeReason
    ? [40, 98, 98, 40, 40, 40, 60, 120]
    : [40, 108, 108, 40, 40, 40, 60];

  widths.forEach((width, index) => {
    table.setColumnWidth(index, width);
  });
}

function appendBodyTableCell_(row, value, alignment, fontSize) {
  const text = String(value || '');
  const cell = row.appendTableCell(text);
  const cellText = cell.editAsText()
    .setForegroundColor('#202124')
    .setFontSize(fontSize || 10)
    .setBold(false);
  const paragraph = cell.getChild(0).asParagraph();
  paragraph.setAlignment(DocumentApp.HorizontalAlignment[alignment || 'LEFT']);
  cellText.setFontFamily('Arial');
  return cell;
}

function shortenAddressForPdf_(address) {
  const text = String(address || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^神奈川県/, '')
    .trim();

  if (text.length <= 18) return text;
  return text.substring(0, 18) + '…';
}

function hasPendingOcr_(photoUrl, ocrRaw, meterValue) {
  return isOcrPending_(photoUrl, meterValue, ocrRaw);
}

function formatOcrError_(message) {
  return 'OCRエラー: ' + String(message || '').trim();
}

function parseNumberOrNull_(value) {
  if (value === '' || value === null || typeof value === 'undefined') return null;
  if (typeof value === 'number') return isNaN(value) ? null : value;

  const normalized = String(value).replace(/[,，\s　]/g, '');
  if (!normalized) return null;
  const num = Number(normalized);
  return isNaN(num) ? null : num;
}

function buildAddressLabel_(address, lat, lon) {
  const text = String(address || '').trim();
  if (text) return text;

  const latNum = parseNumberOrNull_(lat);
  const lonNum = parseNumberOrNull_(lon);
  if (latNum === null || lonNum === null) return '';

  return latNum.toFixed(5) + ', ' + lonNum.toFixed(5);
}

function formatDateForPdf_(value) {
  const date = new Date(value);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'M/d');
}

function formatNumberForPdf_(value) {
  if (value === null || value === '' || typeof value === 'undefined') return '';
  return Number(value).toLocaleString('ja-JP');
}

function formatMeterForPdf_(value) {
  if (value === null || value === '' || typeof value === 'undefined') return '';
  return String(Math.round(Number(value)));
}

function getMonthlyReportFolder_(configSheet) {
  const folderId = configSheet.getRange('B5').getValue();
  if (!folderId || folderId === '（自動設定）') {
    throw new Error('DriveフォルダIDが設定されていません。setupSheets() を実行してください。');
  }

  const rootFolder = DriveApp.getFolderById(folderId);
  const folderName = '月報PDF';
  const folders = rootFolder.getFoldersByName(folderName);
  return folders.hasNext() ? folders.next() : rootFolder.createFolder(folderName);
}

function trashExistingFilesByName_(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  while (files.hasNext()) {
    files.next().setTrashed(true);
  }
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
    'ID', '乗車日時', '乗車緯度', '乗車経度', '乗車住所',
    '乗車時写真', '乗車OCR', '開始値',
    '降車日時', '降車緯度', '降車経度', '降車住所',
    '降車時写真', '降車OCR', '終了値',
    '業務目的', '走行km', 'ステータス', '作成日時'
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
    'ID', '乗車日時', '乗車緯度', '乗車経度', '乗車住所',
    '乗車時写真', '乗車OCR', '開始値',
    '降車日時', '降車緯度', '降車経度', '降車住所',
    '降車時写真', '降車OCR', '終了値',
    '業務目的', '走行km', 'ステータス', '作成日時'
  ]]);

  SpreadsheetApp.getUi().alert(
    '✅ 列の並び替え完了！（' + numRows + '行を変換）\n\n' +
    '次に applyJournalFormat を実行してください。'
  );
}

// ============================================================
// ヘッダー名だけを現在の表記に更新
// データ本体や列順は変更しない
// ============================================================

function updateJournalHeaders() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(JOURNAL_SHEET);
  if (!sheet) throw new Error('運転日誌シートが見つかりません。');

  sheet.getRange(1, 1, 1, 19).setValues([[
    'ID', '乗車日時', '乗車緯度', '乗車経度', '乗車住所',
    '乗車時写真', '乗車OCR', '開始値',
    '降車日時', '降車緯度', '降車経度', '降車住所',
    '降車時写真', '降車OCR', '終了値',
    '業務目的', '走行km', 'ステータス', '作成日時'
  ]]);

  SpreadsheetApp.getUi().alert('ヘッダー名を更新しました。');
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
// 新規行に書式を適用（startTrip_ から自動呼び出し）
// ============================================================

function formatNewRow_(sheet, rowNum) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheetId = sheet.getSheetId();

  // 垂直整列・折り返しリセット
  sheet.getRange(rowNum, 1, 1, 19).setVerticalAlignment('middle').setWrap(false);

  // 折り返しは住所列・業務目的列のみ ON
  sheet.getRange(rowNum, 5,  1, 1).setWrap(true);  // E: 乗車住所
  sheet.getRange(rowNum, 12, 1, 1).setWrap(true);  // L: 降車住所
  sheet.getRange(rowNum, 16, 1, 1).setWrap(true);  // P: 業務目的

  // 数値フォーマット
  sheet.getRange(rowNum, 2,  1, 1).setNumberFormat('yyyy/MM/dd HH:mm'); // B: 乗車日時
  sheet.getRange(rowNum, 9,  1, 1).setNumberFormat('yyyy/MM/dd HH:mm'); // I: 降車日時
  sheet.getRange(rowNum, 3,  1, 2).setNumberFormat('0.00');             // C:D: 緯度経度
  sheet.getRange(rowNum, 10, 1, 2).setNumberFormat('0.00');             // J:K: 緯度経度
  sheet.getRange(rowNum, 8,  1, 1).setNumberFormat('#,##0');            // H: 開始値
  sheet.getRange(rowNum, 15, 1, 1).setNumberFormat('#,##0');            // O: 終了値
  sheet.getRange(rowNum, 17, 1, 1).setNumberFormat('#,##0');            // Q: 走行km

  // 水平整列
  sheet.getRange(rowNum, 1,  1, 1).setHorizontalAlignment('center');   // A
  sheet.getRange(rowNum, 2,  1, 1).setHorizontalAlignment('center');   // B
  sheet.getRange(rowNum, 3,  1, 2).setHorizontalAlignment('right');    // C:D
  sheet.getRange(rowNum, 5,  1, 1).setHorizontalAlignment('left');     // E
  sheet.getRange(rowNum, 6,  1, 1).setHorizontalAlignment('left');     // F
  sheet.getRange(rowNum, 7,  1, 1).setHorizontalAlignment('right');    // G
  sheet.getRange(rowNum, 8,  1, 1).setHorizontalAlignment('right');    // H
  sheet.getRange(rowNum, 9,  1, 1).setHorizontalAlignment('center');   // I
  sheet.getRange(rowNum, 10, 1, 2).setHorizontalAlignment('right');    // J:K
  sheet.getRange(rowNum, 12, 1, 2).setHorizontalAlignment('left');     // L:M
  sheet.getRange(rowNum, 14, 1, 1).setHorizontalAlignment('right');    // N
  sheet.getRange(rowNum, 15, 1, 1).setHorizontalAlignment('right');    // O
  sheet.getRange(rowNum, 16, 1, 1).setHorizontalAlignment('center');   // P
  sheet.getRange(rowNum, 17, 1, 1).setHorizontalAlignment('right');    // Q
  sheet.getRange(rowNum, 18, 1, 1).setHorizontalAlignment('center');   // R
  sheet.getRange(rowNum, 19, 1, 1).setHorizontalAlignment('center');   // S

  // パディング（Sheets Advanced Service）
  try {
    Sheets.Spreadsheets.batchUpdate({
      requests: [{
        repeatCell: {
          range: {
            sheetId:       sheetId,
            startRowIndex: rowNum - 1,
            endRowIndex:   rowNum
          },
          cell: {
            userEnteredFormat: {
              padding: { top: 5, right: 10, bottom: 5, left: 10 }
            }
          },
          fields: 'userEnteredFormat.padding'
        }
      }]
    }, ss.getId());
  } catch(e) {
    // Sheets Advanced Service 未設定の場合はスキップ（書式のみ適用済み）
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
  const formatRows = Math.min(Math.max(lastRow, 2), 1000);
  const dataRows   = formatRows - 1;

  // ヘッダー書式
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 36);
  sheet.getRange(1, 1, 1, 19)
    .setFontColor('#ffffff')
    .setFontWeight('normal')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.getRange(1, 1, 1, 8).setBackground('#4d7aa2');   // 乗車
  sheet.getRange(1, 9, 1, 7).setBackground('#6a8f63');   // 降車
  sheet.getRange(1, 16, 1, 4).setBackground('#9a765b');  // 業務/状態

  // 本文書式
  const bodyRange = sheet.getRange(2, 1, dataRows, 19);
  bodyRange
    .setVerticalAlignment('middle')
    .setWrap(false);

  // 日付・数値フォーマット
  sheet.getRange(2, 2, dataRows, 1).setNumberFormat('yyyy/MM/dd HH:mm'); // B
  sheet.getRange(2, 9, dataRows, 1).setNumberFormat('yyyy/MM/dd HH:mm'); // I
  sheet.getRange(2, 3, dataRows, 2).setNumberFormat('0.00');             // C:D
  sheet.getRange(2, 10, dataRows, 2).setNumberFormat('0.00');            // J:K
  sheet.getRange(2, 8, dataRows, 1).setNumberFormat('#,##0');            // H
  sheet.getRange(2, 15, dataRows, 1).setNumberFormat('#,##0');           // O
  sheet.getRange(2, 17, dataRows, 1).setNumberFormat('#,##0');           // Q

  // 寄せ方
  sheet.getRange(2, 1, dataRows, 1).setHorizontalAlignment('center');    // A
  sheet.getRange(2, 2, dataRows, 1).setHorizontalAlignment('center');    // B
  sheet.getRange(2, 9, dataRows, 1).setHorizontalAlignment('center');    // I
  sheet.getRange(2, 18, dataRows, 1).setHorizontalAlignment('center');   // R
  sheet.getRange(2, 19, dataRows, 1).setHorizontalAlignment('center');   // S
  sheet.getRange(2, 3, dataRows, 2).setHorizontalAlignment('right');     // C:D
  sheet.getRange(2, 8, dataRows, 1).setHorizontalAlignment('right');     // H
  sheet.getRange(2, 10, dataRows, 2).setHorizontalAlignment('right');    // J:K
  sheet.getRange(2, 15, dataRows, 1).setHorizontalAlignment('right');    // O
  sheet.getRange(2, 17, dataRows, 1).setHorizontalAlignment('right');    // Q
  sheet.getRange(2, 5, dataRows, 1).setHorizontalAlignment('left');      // E
  sheet.getRange(2, 6, dataRows, 1).setHorizontalAlignment('left');      // F
  sheet.getRange(2, 7, dataRows, 1).setHorizontalAlignment('right');     // G
  sheet.getRange(2, 12, dataRows, 2).setHorizontalAlignment('left');     // L:M
  sheet.getRange(2, 14, dataRows, 1).setHorizontalAlignment('right');    // N
  sheet.getRange(2, 16, dataRows, 1).setHorizontalAlignment('center');   // P

  // 折り返しは住所列・業務目的列のみ
  sheet.getRange(2, 5, dataRows, 1).setWrap(true);                       // E
  sheet.getRange(2, 12, dataRows, 1).setWrap(true);                      // L
  sheet.getRange(2, 16, dataRows, 1).setWrap(true);                      // P

  const colWidths = [
     46,  // A : ID
    136,  // B : 乗車日時
     60,  // C : 乗車緯度
     60,  // D : 乗車経度
    200,  // E : 乗車住所
    110,  // F : 乗車時写真
     70,  // G : 乗車OCR
     70,  // H : 開始値
    136,  // I : 降車日時
     60,  // J : 降車緯度
     60,  // K : 降車経度
    200,  // L : 降車住所
    110,  // M : 降車時写真
     70,  // N : 降車OCR
     70,  // O : 終了値
     90,  // P : 業務目的
     72,  // Q : 走行距離(km)
     72,  // R : ステータス
    180   // S : 作成日時
  ];

  const rules = [];
  const statusRange = sheet.getRange(2, 18, dataRows, 1);
  const startOcrRange = sheet.getRange(2, 7, dataRows, 1);
  const endOcrRange = sheet.getRange(2, 14, dataRows, 1);
  const distanceRange = sheet.getRange(2, 17, dataRows, 1);

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('open')
      .setBackground('#fff4cc')
      .setFontColor('#8a5a00')
      .setRanges([statusRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('closed')
      .setBackground('#d7f5e6')
      .setFontColor('#0d6a3b')
      .setRanges([statusRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($F2<>"",$H2="",ISTEXT($G2),$G2<>"")')
      .setBackground('#fde4ea')
      .setFontColor('#a61b39')
      .setRanges([startOcrRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($M2<>"",$O2="",ISTEXT($N2),$N2<>"")')
      .setBackground('#fde4ea')
      .setFontColor('#a61b39')
      .setRanges([endOcrRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(500)
      .setBackground('#fff1d6')
      .setFontColor('#8a5200')
      .setRanges([distanceRange])
      .build()
  );
  sheet.setConditionalFormatRules(rules);

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

// ============================================================
// 月次アーカイブパック作成
// 指定月のデータ・PDF・写真を Drive にまとめる
// ============================================================

function createMonthlyPackCore_(year, month) {
  if (!year || !month) {
    return { success: false, error: 'year と month を指定してください' };
  }
  year  = Number(year);
  month = Number(month);
  const label = Utilities.formatString('%04d-%02d', year, month);

  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(JOURNAL_SHEET);
  const config  = ss.getSheetByName(CONFIG_SHEET);
  const allData = sheet.getDataRange().getValues();

  const headers  = allData[0];
  const dataRows = allData.slice(1).filter(row => {
    const d = new Date(row[1]);
    return !isNaN(d) && d.getFullYear() === year && (d.getMonth() + 1) === month;
  });

  if (dataRows.length === 0) {
    return { success: false, error: label + ' のデータが見つかりませんでした' };
  }

  const folderId  = config.getRange('B5').getValue();
  const rootFolder = DriveApp.getFolderById(folderId);
  const archiveIter = rootFolder.getFoldersByName('アーカイブ');
  const archiveRoot = archiveIter.hasNext() ? archiveIter.next() : rootFolder.createFolder('アーカイブ');

  // 既存の月フォルダがあれば一時退避（処理成功後にゴミ箱へ、失敗時は手動復旧用に残す）
  const oldFolders = [];
  const existingIter = archiveRoot.getFoldersByName(label);
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  while (existingIter.hasNext()) {
    const old = existingIter.next();
    old.setName(label + '_old_' + stamp);
    oldFolders.push(old);
  }

  const monthFolder = archiveRoot.createFolder(label);

  try {
    // ① スプレッドシートを作成してデータをコピー
    const newSs   = SpreadsheetApp.create(label + '_運転データ');
    const newSheet = newSs.getActiveSheet();
    newSheet.setName('運転日誌');
    newSheet.appendRow(headers);
    dataRows.forEach(row => newSheet.appendRow(row));
    newSheet.getRange(1, 1, 1, headers.length)
      .setBackground('#4d7aa2').setFontColor('#ffffff').setFontWeight('bold');
    newSheet.setFrozenRows(1);

    const newSsFile = DriveApp.getFileById(newSs.getId());
    monthFolder.addFile(newSsFile);
    DriveApp.getRootFolder().removeFile(newSsFile);

    // ② 写真を写真フォルダにコピー
    const photoFolder = monthFolder.createFolder('写真');
    const copiedCount = { ok: 0, err: 0 };

    dataRows.forEach(row => {
      [row[5], row[12]].forEach(url => {
        if (!url) return;
        const match = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (!match) return;
        try {
          const file = DriveApp.getFileById(match[1]);
          file.makeCopy(file.getName(), photoFolder);
          copiedCount.ok++;
        } catch(e) {
          copiedCount.err++;
        }
      });
    });

    // ③ 月次PDFを生成してパックフォルダに移動
    let pdfUrl = '';
    try {
      const pdfResult = JSON.parse(generateMonthlyPDF_(year, month).getContent());
      if (pdfResult.success) {
        const pdfIter = DriveApp.getFilesByName(label + '_運転月報.pdf');
        if (pdfIter.hasNext()) {
          const pdfFile = pdfIter.next();
          pdfFile.makeCopy(pdfFile.getName(), monthFolder);
          pdfUrl = pdfResult.pdfUrl;
        }
      }
    } catch(e) {
      // PDF生成失敗は警告のみ
    }

    // 成功 → 退避した旧フォルダをゴミ箱へ
    oldFolders.forEach(f => { try { f.setTrashed(true); } catch(e) {} });

    const folderUrl = monthFolder.getUrl();
    const message =
      '✅ ' + label + ' アーカイブ完了\n' +
      '・データ ' + dataRows.length + '件\n' +
      '・写真 ' + copiedCount.ok + '枚' + (copiedCount.err > 0 ? '（' + copiedCount.err + '件エラー）' : '') + '\n' +
      '・PDF ' + (pdfUrl ? '生成済み' : '生成スキップ');
    Logger.log('[createMonthlyPack] ' + message + ' / ' + folderUrl);

    return {
      success: true,
      label: label,
      message: message,
      folderUrl: folderUrl,
      pdfUrl: pdfUrl,
      dataCount: dataRows.length,
      photoOk: copiedCount.ok,
      photoErr: copiedCount.err
    };
  } catch (err) {
    // 失敗 → 新フォルダを削除（旧フォルダは _old_ で残る）
    try { monthFolder.setTrashed(true); } catch(e) {}
    throw err;
  }
}

// スクリプトエディタから手動実行する場合のラッパー
function createMonthlyPack(year, month) {
  const result = createMonthlyPackCore_(year, month);
  const text = result.success ? result.message + '\n\nフォルダ: ' + result.folderUrl : result.error;
  try { SpreadsheetApp.getUi().alert(text); } catch(e) {}
  return result;
}

// 運転日誌からアーカイブ可能な年月を一覧化（アーカイブ済み状態も付与）
function listArchivableMonths_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(JOURNAL_SHEET);
  const config = ss.getSheetByName(CONFIG_SHEET);
  const data = sheet.getDataRange().getValues();

  const monthMap = {};
  for (let i = 1; i < data.length; i++) {
    const d = new Date(data[i][1]);
    if (isNaN(d)) continue;
    const key = Utilities.formatString('%04d-%02d', d.getFullYear(), d.getMonth() + 1);
    if (!monthMap[key]) {
      monthMap[key] = { year: d.getFullYear(), month: d.getMonth() + 1, count: 0 };
    }
    monthMap[key].count++;
  }

  const archived = {};
  try {
    const folderId = config.getRange('B5').getValue();
    const rootFolder = DriveApp.getFolderById(folderId);
    const archiveIter = rootFolder.getFoldersByName('アーカイブ');
    if (archiveIter.hasNext()) {
      const folders = archiveIter.next().getFolders();
      while (folders.hasNext()) {
        const f = folders.next();
        const name = f.getName();
        if (/^\d{4}-\d{2}$/.test(name)) {
          archived[name] = {
            archivedAt: f.getLastUpdated().toISOString(),
            folderUrl: f.getUrl()
          };
        }
      }
    }
  } catch(e) {
    // アーカイブフォルダ取得失敗は無視（未アーカイブ扱い）
  }

  const months = Object.keys(monthMap).sort().reverse().map(key => ({
    label: key,
    year: monthMap[key].year,
    month: monthMap[key].month,
    tripCount: monthMap[key].count,
    archived: !!archived[key],
    archivedAt: archived[key] ? archived[key].archivedAt : null,
    folderUrl: archived[key] ? archived[key].folderUrl : null
  }));

  return jsonResponse_({ success: true, months: months });
}

