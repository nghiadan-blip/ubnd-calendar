const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const dbPath = path.join(__dirname, 'database.sqlite');

// Kết nối tới CSDL SQLite
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Lỗi khi kết nối database:', err.message);
  } else {
    console.log('Server đã kết nối thành công tới SQLite database.');
  }
});

// Middleware
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/lich', express.static(path.join(__dirname, 'public')));

// Cấu hình mật khẩu quản trị (Mặc định: NghiaLam@2026, có thể thay đổi bằng biến môi trường)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'NghiaLam@2026';

// Middleware xác thực quyền quản trị cho các API thay đổi dữ liệu
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Chưa cung cấp thông tin mật khẩu quản trị.' });
  }
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
  if (token === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(403).json({ error: 'Mật khẩu quản trị không chính xác.' });
  }
}

// Endpoint kiểm tra đăng nhập quản trị
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, message: 'Đăng nhập thành công!' });
  } else {
    res.status(401).json({ success: false, error: 'Mật khẩu quản trị không đúng.' });
  }
});

/**
 * Hàm kiểm tra trùng phòng họp / tài nguyên bằng câu lệnh SQL
 * Kiểm tra xem có sự kiện nào khác sử dụng cùng địa điểm và có khoảng thời gian đè lên nhau không.
 */
function checkConflict(location, startTime, endTime, excludeId = null) {
  return new Promise((resolve, reject) => {
    // Không tính các lịch đã hủy (cancelled) hoặc hoãn (postponed)
    let sql = `
      SELECT * FROM events 
      WHERE location = ? 
      AND status NOT IN ('cancelled', 'postponed')
      AND NOT (end_time <= ? OR start_time >= ?)
    `;
    const params = [location, startTime, endTime];

    if (excludeId) {
      sql += ` AND id != ?`;
      params.push(excludeId);
    }

    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row); // Trả về cuộc họp bị trùng đầu tiên tìm thấy, hoặc undefined nếu không trùng
      }
    });
  });
}

// ----------------------------------------------------
// API ENDPOINTS
// ----------------------------------------------------

/**
 * 1. Lấy danh sách lịch họp (có hỗ trợ lọc theo khoảng ngày và tìm kiếm)
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
    sql += ` AND end_time <= ?`;
    params.push(`${endDate} 23:59`);
  }
  if (query) {
    sql += ` AND (title LIKE ? OR chairperson LIKE ? OR location LIKE ? OR attendees LIKE ?)`;
    const searchPattern = `%${query}%`;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  sql += ` ORDER BY start_time ASC`;

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Lỗi truy vấn cơ sở dữ liệu: ' + err.message });
    }
    res.json(rows);
  });
});

/**
 * 2. Lấy thông tin một cuộc họp cụ thể
 * GET /api/events/:id
 */
app.get('/api/events/:id', (req, res) => {
  const { id } = req.params;
  db.get(`SELECT * FROM events WHERE id = ?`, [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Lỗi truy vấn cơ sở dữ liệu: ' + err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Không tìm thấy cuộc họp.' });
    }
    res.json(row);
  });
});

/**
 * 3. Tạo lịch họp mới (có kiểm tra trùng phòng họp)
 * POST /api/events
 */
app.post('/api/events', requireAuth, async (req, res) => {
  const {
    title,
    start_time,
    end_time,
    chairperson,
    location,
    attendees,
    preparing_unit,
    category,
    status,
    document_link,
    override_conflict // true/false - cho phép bỏ qua cảnh báo trùng
  } = req.body;

  if (!title || !start_time || !end_time) {
    return res.status(400).json({ error: 'Thiếu các trường bắt buộc (nội dung, thời gian bắt đầu, thời gian kết thúc).' });
  }

  try {
    // 1. Kiểm tra trùng phòng bằng SQL (Chỉ kiểm tra nếu có địa điểm rõ ràng)
    const checkLoc = location || '';
    if (checkLoc) {
      const conflictEvent = await checkConflict(checkLoc, start_time, end_time);
      if (conflictEvent && !override_conflict) {
        return res.status(409).json({
          conflict: true,
          message: `Phòng họp/Địa điểm này đã được đăng ký bởi cuộc họp khác!`,
          conflictEvent: {
            id: conflictEvent.id,
            title: conflictEvent.title,
            start_time: conflictEvent.start_time,
            end_time: conflictEvent.end_time,
            chairperson: conflictEvent.chairperson
          }
        });
      }
    }

    // 2. Chèn vào CSDL
    const sql = `
      INSERT INTO events (title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const values = [
      title,
      start_time,
      end_time,
      chairperson || '',
      location || '',
      attendees || '',
      preparing_unit || '',
      category || 'ubnd',
      status || 'scheduled',
      document_link || ''
    ];

    db.run(sql, values, function(err) {
      if (err) {
        return res.status(500).json({ error: 'Lỗi khi lưu cuộc họp vào cơ sở dữ liệu: ' + err.message });
      }
      res.status(201).json({
        message: 'Tạo lịch họp thành công!',
        eventId: this.lastID
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi kiểm tra phòng họp: ' + error.message });
  }
});

/**
 * 4. Cập nhật lịch họp (có kiểm tra trùng phòng họp)
 * PUT /api/events/:id
 */
app.put('/api/events/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const {
    title,
    start_time,
    end_time,
    chairperson,
    location,
    attendees,
    preparing_unit,
    category,
    status,
    document_link,
    override_conflict
  } = req.body;

  if (!title || !start_time || !end_time) {
    return res.status(400).json({ error: 'Thiếu các trường bắt buộc.' });
  }

  try {
    // 1. Kiểm tra trùng phòng (chỉ kiểm tra nếu có địa điểm và loại trừ chính cuộc họp này)
    const checkLoc = location || '';
    if (checkLoc) {
      const conflictEvent = await checkConflict(checkLoc, start_time, end_time, id);
      if (conflictEvent && !override_conflict) {
        return res.status(409).json({
          conflict: true,
          message: `Phòng họp/Địa điểm này đã được đăng ký bởi cuộc họp khác!`,
          conflictEvent: {
            id: conflictEvent.id,
            title: conflictEvent.title,
            start_time: conflictEvent.start_time,
            end_time: conflictEvent.end_time,
            chairperson: conflictEvent.chairperson
          }
        });
      }
    }

    // 2. Cập nhật cơ sở dữ liệu
    const sql = `
      UPDATE events 
      SET title = ?, start_time = ?, end_time = ?, chairperson = ?, location = ?, 
          attendees = ?, preparing_unit = ?, category = ?, status = ?, document_link = ?
      WHERE id = ?
    `;
    const values = [
      title,
      start_time,
      end_time,
      chairperson || '',
      location || '',
      attendees || '',
      preparing_unit || '',
      category || 'ubnd',
      status || 'scheduled',
      document_link || '',
      id
    ];

    db.run(sql, values, function(err) {
      if (err) {
        return res.status(500).json({ error: 'Lỗi khi cập nhật cơ sở dữ liệu: ' + err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Không tìm thấy cuộc họp để cập nhật.' });
      }
      res.json({ message: 'Cập nhật lịch họp thành công!' });
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi hệ thống: ' + error.message });
  }
});

/**
 * 5. Xóa lịch họp
 * DELETE /api/events/:id
 */
app.delete('/api/events/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM events WHERE id = ?`, [id], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Lỗi khi xóa cuộc họp khỏi cơ sở dữ liệu: ' + err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy cuộc họp để xóa.' });
    }
    res.json({ message: 'Đã xóa lịch họp thành công!' });
  });
});

/**
 * 6. Đồng bộ lịch từ Google Apps Script (Chạy phía server để loại bỏ triệt để lỗi CORS ở trình duyệt)
 * POST /api/sync-gcal
 */
app.post('/api/sync-gcal', requireAuth, async (req, res) => {
  const { appsScriptUrl } = req.body;
  if (!appsScriptUrl) {
    return res.status(400).json({ error: 'Thiếu đường dẫn Google Apps Script URL.' });
  }

  try {
    const today = new Date();
    const startRange = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 ngày trước
    const endRange = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);   // 30 ngày sau
    
    const formatDateISO = (d) => d.toISOString().split('T')[0];
    const fetchUrl = `${appsScriptUrl}?startDate=${formatDateISO(startRange)}&endDate=${formatDateISO(endRange)}`;

    const response = await fetch(fetchUrl);
    if (!response.ok) {
      return res.status(502).json({ error: `Không thể kết nối tới Google Apps Script (HTTP ${response.status})` });
    }

    const gcalEvents = await response.json();
    if (!gcalEvents || !Array.isArray(gcalEvents)) {
      return res.status(502).json({ error: 'Dữ liệu nhận về từ Google Apps Script không hợp lệ.' });
    }

    let insertedCount = 0;
    
    for (const gEvt of gcalEvents) {
      const start = gEvt.start_time.replace('T', ' ');
      const end = gEvt.end_time.replace('T', ' ');
      
      // Kiểm tra trùng lặp
      const exist = await new Promise((resolve) => {
        db.get("SELECT id FROM events WHERE title = ? AND start_time = ?", [gEvt.title, start], (err, row) => {
          resolve(!!row);
        });
      });

      if (!exist) {
        await new Promise((resolve, reject) => {
          const sql = `
            INSERT INTO events (title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;
          const values = [
            gEvt.title,
            start,
            end,
            gEvt.chairperson || '',
            gEvt.location || '',
            gEvt.attendees || '',
            gEvt.preparing_unit || '',
            gEvt.category || 'ubnd',
            gEvt.status || 'scheduled',
            gEvt.document_link || ''
          ];
          db.run(sql, values, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        insertedCount++;
      }
    }

    res.json({ success: true, insertedCount });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi đồng bộ phía máy chủ: ' + error.message });
  }
});

// 7. Lấy cấu hình hệ thống từ server (Public)
app.get('/api/settings', (req, res) => {
  const settingsPath = path.join(__dirname, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      // Masking các dữ liệu nhạy cảm
      const safeSettings = { ...settings };
      if (safeSettings.aiKey) safeSettings.aiKey = '********';
      if (safeSettings.webhookSecret) safeSettings.webhookSecret = '********';
      return res.json(safeSettings);
    } catch (e) {
      return res.status(500).json({ error: 'Lỗi đọc cấu hình từ máy chủ.' });
    }
  }
  res.json({});
});

// 8. Lưu cấu hình hệ thống lên server (Yêu cầu mật khẩu)
app.post('/api/settings', requireAuth, (req, res) => {
  const newSettings = req.body;
  const settingsPath = path.join(__dirname, 'settings.json');
  try {
    let currentSettings = {};
    if (fs.existsSync(settingsPath)) {
      currentSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    
    // Hợp nhất cấu hình, giữ lại aiKey và webhookSecret thật nếu gửi lên là masked '********'
    const mergedSettings = { ...currentSettings, ...newSettings };
    if (newSettings.aiKey === '********') {
      mergedSettings.aiKey = currentSettings.aiKey || '';
    }
    if (newSettings.webhookSecret === '********') {
      mergedSettings.webhookSecret = currentSettings.webhookSecret || '';
    }

    fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2), 'utf8');
    res.json({ message: 'Lưu cấu hình hệ thống thành công!' });
    
    // Kích hoạt đồng bộ ngay lập tức sau khi cấu hình thay đổi
    setTimeout(autoSyncGcal, 1000);
  } catch (e) {
    res.status(500).json({ error: 'Lỗi ghi cấu hình lên máy chủ: ' + e.message });
  }
});

// Middleware xác thực chữ ký bảo mật từ GitHub Webhook
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  const settingsPath = path.join(__dirname, 'settings.json');
  let secret = process.env.GITHUB_WEBHOOK_SECRET || '';

  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.webhookSecret) {
        secret = settings.webhookSecret;
      }
    } catch (e) {}
  }

  // Nếu không thiết lập secret trên server, cho phép bỏ qua kiểm tra để dễ dàng kích hoạt lần đầu
  if (!secret) {
    return next();
  }

  if (!signature) {
    return res.status(401).json({ error: 'Thiếu chữ ký xác thực X-Hub-Signature-256 từ GitHub.' });
  }

  // Sử dụng raw body buffer nhận từ mạng để đảm bảo băm chính xác tuyệt đối
  const payload = req.rawBody ? req.rawBody : JSON.stringify(req.body);
  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');

  try {
    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      next();
    } else {
      res.status(403).json({ error: 'Chữ ký Webhook không khớp.' });
    }
  } catch (err) {
    res.status(400).json({ error: 'Lỗi kiểm tra chữ ký: ' + err.message });
  }
}

// 9. API Webhook tự động kéo mã nguồn từ Github và reload PM2 khi có push
app.post('/api/deploy-webhook', verifyWebhookSignature, (req, res) => {
  console.log('Webhook: Nhận tín hiệu push từ GitHub, bắt đầu tự động deploy...');
  
  // Chạy các lệnh kéo git và reload PM2 trên VPS
  exec('git pull origin master && pm2 reload "app.nghialam.com"', (err, stdout, stderr) => {
    if (err) {
      console.error('Lỗi tự động deploy:', err.message);
      return res.status(500).json({ error: 'Lỗi chạy lệnh deploy: ' + err.message });
    }
    console.log('Deploy thành công:\n', stdout);
    res.json({ success: true, message: 'Đã tự động deploy và cập nhật thành công!', stdout });
  });
});

// Hàm đồng bộ lịch từ Google Apps Script chạy ngầm trên server
async function autoSyncGcal() {
  try {
    const settingsPath = path.join(__dirname, 'settings.json');
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const appsScriptUrl = settings.appsScriptUrl;
    if (!appsScriptUrl) {
      console.log('Đồng bộ định kỳ: Chưa cấu hình Google Apps Script URL trên máy chủ.');
      return;
    }

    console.log('Đồng bộ định kỳ: Bắt đầu tải lịch từ Google Calendar...');
    const today = new Date();
    const startRange = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 ngày trước
    const endRange = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);   // 30 ngày sau
    
    const formatDateISO = (d) => d.toISOString().split('T')[0];
    const fetchUrl = `${appsScriptUrl}?startDate=${formatDateISO(startRange)}&endDate=${formatDateISO(endRange)}`;

    const response = await fetch(fetchUrl);
    if (!response.ok) {
      console.warn(`Đồng bộ định kỳ thất bại: Máy chủ Google trả về mã lỗi HTTP ${response.status}`);
      return;
    }

    const gcalEvents = await response.json();
    if (!gcalEvents || !Array.isArray(gcalEvents)) {
      console.warn('Đồng bộ định kỳ thất bại: Dữ liệu Google Apps Script trả về không đúng định dạng.');
      return;
    }

    let insertedCount = 0;
    for (const gEvt of gcalEvents) {
      const start = gEvt.start_time.replace('T', ' ');
      const end = gEvt.end_time.replace('T', ' ');
      
      const exist = await new Promise((resolve) => {
        db.get("SELECT id FROM events WHERE title = ? AND start_time = ?", [gEvt.title, start], (err, row) => {
          resolve(!!row);
        });
      });

      if (!exist) {
        await new Promise((resolve, reject) => {
          const sql = `
            INSERT INTO events (title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;
          const values = [
            gEvt.title, start, end, gEvt.chairperson || '', gEvt.location || '',
            gEvt.attendees || '', gEvt.preparing_unit || '', gEvt.category || 'ubnd',
            gEvt.status || 'scheduled', gEvt.document_link || ''
          ];
          db.run(sql, values, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        insertedCount++;
      }
    }
    if (insertedCount > 0) {
      console.log(`Đồng bộ định kỳ thành công: Đã tự động chèn thêm ${insertedCount} lịch họp mới từ Google Calendar.`);
    } else {
      console.log('Đồng bộ định kỳ: Dữ liệu lịch làm việc đã đồng nhất.');
    }
  } catch (error) {
    console.error('Lỗi trong tiến trình đồng bộ định kỳ Google Calendar:', error.message);
  }
}

// Tự động tải Quốc huy chính thức từ Wikimedia Commons về thư mục public nếu chưa tồn tại
async function downloadEmblem() {
  const emblemPath = path.join(__dirname, 'public', 'emblem.svg');
  // Luôn thử tải nếu file trống hoặc là file lỗi (dưới 500 bytes)
  let shouldDownload = true;
  if (fs.existsSync(emblemPath)) {
    const stats = fs.statSync(emblemPath);
    if (stats.size > 500) {
      shouldDownload = false;
    }
  }

  if (shouldDownload) {
    try {
      console.log('Đang tự động tải tệp SVG Quốc huy chính thức về máy chủ...');
      const response = await fetch('https://upload.wikimedia.org/wikipedia/commons/e/e0/Emblem_of_Vietnam.svg', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (response.ok) {
        const text = await response.text();
        if (text.includes('<svg') && !text.includes('File not found') && !text.includes('Wikimedia Error')) {
          fs.writeFileSync(emblemPath, text);
          console.log('Đã cập nhật Quốc huy chính thức thành công tại public/emblem.svg');
        } else {
          console.warn('Nội dung tải về không hợp lệ, giữ nguyên Quốc huy dự phòng.');
        }
      } else {
        console.warn('Máy chủ tải logo thất bại, mã lỗi HTTP:', response.status);
      }
    } catch (err) {
      console.error('Không thể tải Quốc huy do lỗi mạng:', err.message);
    }
  }
}

// Khởi động server
app.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(`Máy chủ Lịch làm việc UBND Xã đang chạy tại http://localhost:${PORT}`);
  console.log(`================================================================`);
  downloadEmblem();
  
  // Tự động đồng bộ lịch lần đầu sau khi khởi động 5 giây
  setTimeout(autoSyncGcal, 5000);
  
  // Thiết lập đồng bộ định kỳ mỗi 5 phút (300.000 ms) chạy ngầm hoàn toàn
  setInterval(autoSyncGcal, 300000);
});
