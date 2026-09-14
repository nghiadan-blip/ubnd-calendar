const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const dbPath = process.env.TEST_DB_PATH || path.join(__dirname, 'database.sqlite');

// Tắt header X-Powered-By
app.disable('x-powered-by');

// Kết nối tới CSDL SQLite
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Lỗi khi kết nối database:', err.message);
  } else {
    console.log(`Server đã kết nối thành công tới SQLite database (${path.basename(dbPath)}).`);
    db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        chairperson TEXT NOT NULL,
        location TEXT NOT NULL,
        attendees TEXT,
        preparing_unit TEXT,
        category TEXT NOT NULL DEFAULT 'ubnd',
        status TEXT NOT NULL DEFAULT 'scheduled',
        document_link TEXT,
        gcal_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (initErr) => {
      if (initErr) {
        console.error('Lỗi khởi tạo bảng events:', initErr.message);
      } else {
        console.log('Đã đảm bảo khởi tạo bảng events trong SQLite database.');
        db.run("ALTER TABLE events ADD COLUMN gcal_id TEXT", () => {});
      }
    });
  }
});

// Middleware Security Headers & Strict Same-Origin CORS
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self';");
  next();
});

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/lich', express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// NGUYÊN TẮC AN TOÀN VÀ XÁC THỰC QUẢN TRỊ (FAIL-CLOSED)
// ----------------------------------------------------

// Đọc mật khẩu quản trị từ biến môi trường hoặc file settings.json
function getAdminPassword() {
  if (process.env.ADMIN_PASSWORD) {
    return process.env.ADMIN_PASSWORD;
  }
  const settingsPath = path.join(__dirname, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.adminPassword) return settings.adminPassword;
    } catch (e) {}
  }
  return null;
}

// Đọc secret webhook
function getWebhookSecret() {
  if (process.env.GITHUB_WEBHOOK_SECRET) {
    return process.env.GITHUB_WEBHOOK_SECRET;
  }
  const settingsPath = path.join(__dirname, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.webhookSecret) return settings.webhookSecret;
    } catch (e) {}
  }
  return null;
}

// Lưu trữ các token phiên làm việc active trong bộ nhớ (hạn 24h)
const activeSessions = new Map();

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of activeSessions.entries()) {
    if (session.expiresAt < now) {
      activeSessions.delete(token);
    }
  }
}
setInterval(cleanExpiredSessions, 3600000);

// Rate limiting cho đăng nhập (tối đa 5 lần thử sai trong 1 phút per IP)
const loginAttempts = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || [];
  const recent = attempts.filter(t => now - t < 60000);
  loginAttempts.set(ip, recent);
  return recent.length >= 5;
}
function recordFailedAttempt(ip) {
  const attempts = loginAttempts.get(ip) || [];
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts);
}

// Middleware xác thực quyền quản trị (Fail-Closed)
function requireAuth(req, res, next) {
  const adminPassword = getAdminPassword();
  if (!adminPassword) {
    return res.status(401).json({
      error: 'Chưa cấu hình mật khẩu quản trị (ADMIN_PASSWORD). Vui lòng cấu hình biến môi trường ADMIN_PASSWORD hoặc cài đặt trong settings.json.'
    });
  }

  const authHeader = req.headers['authorization'];
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers['x-admin-token']) {
    token = req.headers['x-admin-token'];
  }

  if (!token) {
    return res.status(401).json({ error: 'Yêu cầu xác thực. Vui lòng đăng nhập tài khoản quản trị.' });
  }

  const session = activeSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (session) activeSessions.delete(token);
    return res.status(401).json({ error: 'Phiên làm việc đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại.' });
  }

  req.adminSession = session;
  next();
}

// Endpoint đăng nhập quản trị (POST /api/auth/login)
app.post('/api/auth/login', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';

  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng đợi 1 phút trước khi thử lại.' });
  }

  const adminPassword = getAdminPassword();
  if (!adminPassword) {
    return res.status(401).json({ error: 'Máy chủ chưa được cấu hình mật khẩu quản trị (ADMIN_PASSWORD).' });
  }

  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    recordFailedAttempt(clientIp);
    return res.status(401).json({ error: 'Mật khẩu đăng nhập không chính xác.' });
  }

  const passwordBuf = Buffer.from(password);
  const targetBuf = Buffer.from(adminPassword);

  if (passwordBuf.length !== targetBuf.length || !crypto.timingSafeEqual(passwordBuf, targetBuf)) {
    recordFailedAttempt(clientIp);
    return res.status(401).json({ error: 'Mật khẩu đăng nhập không chính xác.' });
  }

  // Cấp token phiên ngẫu nhiên an toàn (24 giờ)
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  activeSessions.set(token, { createdAt: Date.now(), expiresAt, ip: clientIp });

  res.json({
    success: true,
    token,
    expiresAt,
    message: 'Đăng nhập quản trị thành công!'
  });
});

// Endpoint đăng xuất (POST /api/auth/logout)
app.post('/api/auth/logout', requireAuth, (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    activeSessions.delete(authHeader.substring(7));
  }
  res.json({ success: true, message: 'Đã đăng xuất phiên làm việc.' });
});

// ----------------------------------------------------
// BẢO VỆ CHỐNG SSRF CHO GOOGLE APPS SCRIPT SYNC
// ----------------------------------------------------
function validateGoogleAppsScriptUrl(targetUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (e) {
    return { valid: false, reason: 'URL không đúng định dạng hợp lệ.' };
  }

  if (parsedUrl.protocol !== 'https:') {
    return { valid: false, reason: 'Chỉ chấp nhận kết nối an toàn HTTPS.' };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const isAllowedHost = hostname === 'script.google.com' ||
                        hostname === 'script.googleusercontent.com' ||
                        hostname.endsWith('.google.com') ||
                        hostname.endsWith('.googleusercontent.com');

  if (!isAllowedHost) {
    return { valid: false, reason: 'URL Google Apps Script phải thuộc tên miền *.google.com hoặc *.googleusercontent.com.' };
  }

  // Chặn IP nội bộ / Loopback / Metadata Endpoint
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
      hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('169.254.') ||
      hostname.startsWith('172.16.') || hostname.startsWith('172.17.') || hostname.startsWith('172.31.')) {
    return { valid: false, reason: 'Không cho phép kết nối tới IP nội bộ hoặc loopback.' };
  }

  return { valid: true, parsedUrl };
}

// ----------------------------------------------------
// SANITIZE & VALIDATION HELPERS FOR EVENTS
// ----------------------------------------------------
function sanitizeInput(str) {
  if (str === null || str === undefined) return '';
  return String(str).trim();
}

function validateEventFields(body) {
  const title = sanitizeInput(body.title);
  const start_time = sanitizeInput(body.start_time).replace('T', ' ');
  const end_time = sanitizeInput(body.end_time).replace('T', ' ');
  const chairperson = sanitizeInput(body.chairperson);
  const location = sanitizeInput(body.location);
  const attendees = sanitizeInput(body.attendees);
  const preparing_unit = sanitizeInput(body.preparing_unit);
  const category = sanitizeInput(body.category) || 'ubnd';
  const status = sanitizeInput(body.status) || 'scheduled';
  let document_link = sanitizeInput(body.document_link);

  if (!title) return { valid: false, error: 'Tiêu đề/Nội dung cuộc họp không được để trống.' };
  if (title.length > 500) return { valid: false, error: 'Tiêu đề cuộc họp không vượt quá 500 ký tự.' };
  if (!start_time) return { valid: false, error: 'Thời gian bắt đầu không được để trống.' };
  if (!end_time) return { valid: false, error: 'Thời gian kết thúc không được để trống.' };

  if (document_link && !document_link.startsWith('https://')) {
    return { valid: false, error: 'Liên kết tài liệu phải bắt đầu bằng https://' };
  }

  return {
    valid: true,
    data: {
      title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link
    }
  };
}

// ----------------------------------------------------
// API ENDPOINTS
// ----------------------------------------------------

/**
 * 1. Lấy danh sách lịch họp (Public)
 * GET /api/events?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&query=xyz
 */
app.get('/api/events', (req, res) => {
  const { startDate, endDate, query } = req.query;
  let sql = `SELECT * FROM events WHERE 1=1`;
  const params = [];

  if (startDate) {
    sql += ` AND start_time >= ?`;
    params.push(`${startDate} 00:00`);
  }
  if (endDate) {
    sql += ` AND start_time <= ?`;
    params.push(`${endDate} 23:59`);
  }
  if (query) {
    sql += ` AND (title LIKE ? OR chairperson LIKE ? OR location LIKE ? OR attendees LIKE ?)`;
    const searchPattern = `%${sanitizeInput(query)}%`;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  sql += ` ORDER BY start_time ASC`;

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Lỗi truy vấn cơ sở dữ liệu.' });
    }
    res.json(rows || []);
  });
});

/**
 * 2. Lấy chi tiết một cuộc họp (Public)
 * GET /api/events/:id
 */
app.get('/api/events/:id', (req, res) => {
  const { id } = req.params;
  db.get(`SELECT * FROM events WHERE id = ?`, [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Lỗi truy vấn cơ sở dữ liệu.' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Không tìm thấy cuộc họp.' });
    }
    res.json(row);
  });
});

/**
 * 3. Tạo lịch họp mới (Yêu cầu xác thực Admin)
 * POST /api/events
 */
app.post('/api/events', requireAuth, (req, res) => {
  const validation = validateEventFields(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const { title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link } = validation.data;

  const sql = `
    INSERT INTO events (title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const values = [title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link];

  db.run(sql, values, function(err) {
    if (err) {
      return res.status(500).json({ error: 'Lỗi khi lưu cuộc họp vào cơ sở dữ liệu.' });
    }
    res.status(201).json({
      message: 'Tạo lịch họp thành công!',
      eventId: this.lastID
    });
  });
});

/**
 * 4. Cập nhật lịch họp (Yêu cầu xác thực Admin)
 * PUT /api/events/:id
 */
app.put('/api/events/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const validation = validateEventFields(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const { title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link } = validation.data;

  const sql = `
    UPDATE events 
    SET title = ?, start_time = ?, end_time = ?, chairperson = ?, location = ?, 
        attendees = ?, preparing_unit = ?, category = ?, status = ?, document_link = ?
    WHERE id = ?
  `;
  const values = [title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link, id];

  db.run(sql, values, function(err) {
    if (err) {
      return res.status(500).json({ error: 'Lỗi khi cập nhật cơ sở dữ liệu.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy cuộc họp để cập nhật.' });
    }
    res.json({ message: 'Cập nhật lịch họp thành công!' });
  });
});

/**
 * 5. Xóa lịch họp (Yêu cầu xác thực Admin)
 * DELETE /api/events/:id
 */
app.delete('/api/events/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM events WHERE id = ?`, [id], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Lỗi khi xóa cuộc họp khỏi cơ sở dữ liệu.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy cuộc họp để xóa.' });
    }
    res.json({ message: 'Đã xóa lịch họp thành công!' });
  });
});

// Hàm phân tích ô Description từ Google Calendar
function parseGcalDescription(desc, defaultLoc) {
  const result = {
    location: defaultLoc || '',
    chairperson: '',
    attendees: '',
    preparing_unit: '',
    document_link: ''
  };

  if (!desc) return result;
  const clean = desc.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

  const linkMatch = clean.match(/https:\/\/[^\s<>"]+/i);
  if (linkMatch) {
    result.document_link = linkMatch[0];
  }

  const chairMatch = clean.match(/(?:Chủ trì|chu tri)\s*[:\s–-]?\s*([^.\n;]+)/i);
  if (chairMatch && chairMatch[1]) {
    result.chairperson = chairMatch[1].trim();
  }

  if (!result.location) {
    const locMatch = clean.match(/(?:Địa điểm|dia diem|tại|tai)\s*[:\s–-]?\s*([^.\n;]+)/i);
    if (locMatch && locMatch[1]) {
      result.location = locMatch[1].trim();
    }
  }

  const attMatch = clean.match(/(?:Thành phần|thanh phan)\s*[:\s–-]?\s*([^.\n;]+)/i);
  if (attMatch && attMatch[1]) {
    result.attendees = attMatch[1].trim();
  }

  const prepMatch = clean.match(/(?:Đơn vị chuẩn bị|chuẩn bị)\s*[:\s–-]?\s*([^.\n;]+)/i);
  if (prepMatch && prepMatch[1]) {
    result.preparing_unit = prepMatch[1].trim();
  }

  return result;
}

// Hàm UPSERT sự kiện Google Calendar
async function upsertGcalEvents(gcalEvents) {
  if (!Array.isArray(gcalEvents)) return { insertedCount: 0, updatedCount: 0 };
  let insertedCount = 0;
  let updatedCount = 0;

  for (const gEvt of gcalEvents) {
    if (!gEvt || !gEvt.title || !gEvt.start_time) continue;
    const gcalId = gEvt.gcal_id || gEvt.google_event_id || gEvt.id || '';
    const start = String(gEvt.start_time).replace('T', ' ');
    const end = String(gEvt.end_time || gEvt.start_time).replace('T', ' ');

    const descInfo = parseGcalDescription(gEvt.description, gEvt.location);
    const finalChair = gEvt.chairperson || descInfo.chairperson || 'Lãnh đạo UBND xã';
    const finalLoc = gEvt.location || descInfo.location || 'Phòng họp UBND xã';
    const finalAtt = gEvt.attendees || descInfo.attendees || '';
    const finalPrep = gEvt.preparing_unit || descInfo.preparing_unit || '';
    const finalDoc = (gEvt.document_link && gEvt.document_link.startsWith('https://')) ? gEvt.document_link : descInfo.document_link;

    let existingRow = null;
    if (gcalId) {
      existingRow = await new Promise((resolve) => {
        db.get("SELECT id FROM events WHERE gcal_id = ?", [gcalId], (err, row) => resolve(row || null));
      });
    }
    if (!existingRow) {
      existingRow = await new Promise((resolve) => {
        db.get("SELECT id FROM events WHERE title = ? AND start_time = ?", [gEvt.title, start], (err, row) => resolve(row || null));
      });
    }

    if (existingRow) {
      await new Promise((resolve, reject) => {
        const sql = `
          UPDATE events 
          SET title = ?, start_time = ?, end_time = ?, chairperson = ?, location = ?, attendees = ?, preparing_unit = ?, category = ?, status = ?, document_link = ?, gcal_id = ?
          WHERE id = ?
        `;
        const values = [
          gEvt.title, start, end, finalChair, finalLoc, finalAtt, finalPrep,
          gEvt.category || 'ubnd', gEvt.status || 'scheduled', finalDoc, gcalId, existingRow.id
        ];
        db.run(sql, values, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      updatedCount++;
    } else {
      await new Promise((resolve, reject) => {
        const sql = `
          INSERT INTO events (title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link, gcal_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const values = [
          gEvt.title, start, end, finalChair, finalLoc, finalAtt, finalPrep,
          gEvt.category || 'ubnd', gEvt.status || 'scheduled', finalDoc, gcalId
        ];
        db.run(sql, values, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      insertedCount++;
    }
  }

  return { insertedCount, updatedCount };
}

/**
 * 6. Đồng bộ Google Calendar (Yêu cầu xác thực Admin)
 * POST /api/sync-gcal
 */
app.post('/api/sync-gcal', requireAuth, async (req, res) => {
  try {
    let targetUrl = null;
    const settingsPath = path.join(__dirname, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        targetUrl = settings.appsScriptUrl;
      } catch (e) {}
    }

    if (!targetUrl && process.env.APPS_SCRIPT_URL) {
      targetUrl = process.env.APPS_SCRIPT_URL;
    }

    if (!targetUrl) {
      return res.status(400).json({ error: 'Chưa cấu hình Google Apps Script URL trong cài đặt máy chủ.' });
    }

    const validation = validateGoogleAppsScriptUrl(targetUrl);
    if (!validation.valid) {
      return res.status(400).json({ error: `URL Google Apps Script không hợp lệ: ${validation.reason}` });
    }

    const today = new Date();
    const startRange = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const endRange = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    const formatDateISO = (d) => d.toISOString().split('T')[0];

    const fetchUrl = `${targetUrl}?startDate=${formatDateISO(startRange)}&endDate=${formatDateISO(endRange)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await safeFetch(fetchUrl, {
      redirect: 'manual',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(502).json({ error: `Kết nối Google Apps Script thất bại (HTTP ${response.status})` });
    }

    const responseText = await response.text();
    if (responseText.length > 2 * 1024 * 1024) {
      return res.status(502).json({ error: 'Dữ liệu phản hồi từ Google quá lớn.' });
    }

    let gcalEvents = [];
    try {
      gcalEvents = JSON.parse(responseText);
    } catch (parseErr) {
      return res.status(502).json({ error: 'Dữ liệu trả về không đúng định dạng JSON.' });
    }

    if (!Array.isArray(gcalEvents)) {
      return res.status(502).json({ error: 'Dữ liệu Google Apps Script không phải định dạng danh sách.' });
    }

    const { insertedCount, updatedCount } = await upsertGcalEvents(gcalEvents);
    res.json({ success: true, insertedCount, updatedCount, message: `Đồng bộ thành công! Thêm mới: ${insertedCount}, Cập nhật: ${updatedCount}` });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi máy chủ trong quá trình đồng bộ.' });
  }
});

/**
 * 7. Lấy cấu hình hệ thống (Public - Đã ẩn thông tin nhạy cảm)
 * GET /api/settings
 */
app.get('/api/settings', (req, res) => {
  const settingsPath = path.join(__dirname, 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {}
  }

  const safeSettings = {
    appsScriptUrl: settings.appsScriptUrl || '',
    hasWebhookSecret: Boolean(getWebhookSecret()),
    hasAdminPassword: Boolean(getAdminPassword())
  };

  res.json(safeSettings);
});

/**
 * 8. Lưu cấu hình hệ thống (Yêu cầu Admin)
 * POST /api/settings
 */
app.post('/api/settings', requireAuth, (req, res) => {
  const newSettings = req.body || {};
  const settingsPath = path.join(__dirname, 'settings.json');

  try {
    let currentSettings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        currentSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (e) {}
    }

    const mergedSettings = { ...currentSettings, ...newSettings };
    if (newSettings.webhookSecret === '********') {
      mergedSettings.webhookSecret = currentSettings.webhookSecret || '';
    }
    if (newSettings.adminPassword === '********') {
      mergedSettings.adminPassword = currentSettings.adminPassword || '';
    }

    fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2), 'utf8');
    res.json({ message: 'Lưu cấu hình hệ thống thành công!' });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi ghi file cấu hình.' });
  }
});

// Middleware xác thực chữ ký Webhook (Fail-Closed)
const processedDeliveries = new Set();
function verifyWebhookSignature(req, res, next) {
  const secret = getWebhookSecret();
  if (!secret) {
    return res.status(401).json({ error: 'Máy chủ chưa được cấu hình Webhook Secret.' });
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    return res.status(401).json({ error: 'Thiếu chữ ký xác thực X-Hub-Signature-256.' });
  }

  const deliveryId = req.headers['x-github-delivery'];
  if (deliveryId) {
    if (processedDeliveries.has(deliveryId)) {
      return res.status(200).json({ message: 'Tín hiệu Delivery ID đã được xử lý trước đó.' });
    }
    processedDeliveries.add(deliveryId);
    if (processedDeliveries.size > 1000) {
      const firstKey = processedDeliveries.values().next().value;
      processedDeliveries.delete(firstKey);
    }
  }

  const payload = req.rawBody ? req.rawBody : JSON.stringify(req.body);
  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');

  try {
    const sigBuf = Buffer.from(signature);
    const digBuf = Buffer.from(digest);
    if (sigBuf.length === digBuf.length && crypto.timingSafeEqual(sigBuf, digBuf)) {
      next();
    } else {
      res.status(403).json({ error: 'Chữ ký Webhook không chính xác.' });
    }
  } catch (err) {
    res.status(400).json({ error: 'Lỗi xác thực chữ ký Webhook.' });
  }
}

/**
 * 9. API Webhook tự động reload PM2 khi có push nhánh master
 * POST /api/deploy-webhook
 */
app.post('/api/deploy-webhook', verifyWebhookSignature, (req, res) => {
  const event = req.headers['x-github-event'];
  if (event !== 'push') {
    return res.json({ message: 'Bỏ qua sự kiện không phải push.' });
  }

  const ref = req.body ? req.body.ref : null;
  if (ref && ref !== 'refs/heads/master') {
    return res.json({ message: 'Bỏ qua push ngoài nhánh master.' });
  }

  console.log('Webhook: Nhận tín hiệu push master thành công, kích hoạt pm2 reload app.nghialam.com...');

  execFile('pm2', ['reload', 'app.nghialam.com', '--update-env'], (err) => {
    if (err) {
      console.error('Lỗi khi thực thi pm2 reload:', err.message);
      return res.status(500).json({ error: 'Tự động cập nhật thất bại.' });
    }
    res.json({ success: true, message: 'Đã cập nhật dịch vụ thành công!' });
  });
});

// Safe Fetch wrapper để không bị ReferenceError ở Node < 18
const safeFetch = (...args) => {
  if (typeof fetch === 'function') {
    return fetch(...args);
  }
  return Promise.reject(new Error('Môi trường Node.js chưa hỗ trợ native fetch.'));
};

// Tự động tải Quốc huy chính thức từ Wikimedia Commons
async function downloadEmblem() {
  const emblemPath = path.join(__dirname, 'public', 'emblem.svg');
  let shouldDownload = true;
  if (fs.existsSync(emblemPath)) {
    const stats = fs.statSync(emblemPath);
    if (stats.size > 500) shouldDownload = false;
  }

  if (shouldDownload) {
    try {
      const response = await safeFetch('https://upload.wikimedia.org/wikipedia/commons/e/e0/Emblem_of_Vietnam.svg', {
        headers: { 'User-Agent': 'UBND-NghiaLam-Calendar/1.0' }
      });
      if (response && response.ok) {
        const text = await response.text();
        if (text.includes('<svg') && !text.includes('File not found')) {
          fs.writeFileSync(emblemPath, text);
        }
      }
    } catch (err) {}
  }
}

// Khởi động server khi được chạy làm entry point chính (kể cả với PM2)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`================================================================`);
    console.log(`Máy chủ Lịch làm việc UBND Xã đang chạy tại http://localhost:${PORT}`);
    console.log(`================================================================`);
    downloadEmblem();
  });
}

module.exports = app;

