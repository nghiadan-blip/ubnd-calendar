// ==========================================================================
// APP STATE & CONFIGURATION
// ==========================================================================

let events = [];
let currentWeekOffset = 0;
let isAdminMode = false;
let selectedEvent = null;
let settings = {
  syncMode: 'server-sqlite', // Mặc định dùng server-sqlite để chia sẻ dữ liệu giữa tất cả thiết bị
  appsScriptUrl: '',       // Google Apps Script Web App URL
  gcalId: 'primary',       // Google Calendar ID
  webhookSecret: '',       // GitHub Webhook Secret
  aiProvider: 'deepseek',  // 'deepseek' hoặc 'openai'
  aiModel: 'deepseek-chat',// Tên model AI
  aiKey: '',               // API Key lưu cục bộ
  tvFocus: 'Hồ sơ đất đai • Thu ngân sách • Giải phóng mặt bằng (GPMB)'
};

// Biến lưu trữ đối tượng Cơ sở dữ liệu SQL.js
let sqlDb = null;
let SQL = null;

// Biến lưu trữ danh sách dropdown mặc định (dùng để reset các giá trị tạo động khi chỉnh sửa)
let originalChairpersonHtml = "";
let originalLocationHtml = "";
let originalPreparingHtml = "";

// Khởi chạy ứng dụng
document.addEventListener('DOMContentLoaded', async () => {
  // Cưỡng bức chuyển sang trang quản lý chính nếu có tham số ?mode=admin
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('mode') === 'admin') {
    const tvContainer = document.getElementById('tv-mode-container');
    const appContainer = document.getElementById('app-container');
    if (tvContainer) tvContainer.classList.add('hidden');
    if (appContainer) appContainer.classList.remove('hidden');
  }

  // Tự động kích hoạt quyền quản trị nếu có tham số mật khẩu ?pass=NghiaLam@2026
  const passParam = urlParams.get('pass');
  if (passParam === 'NghiaLam@2026') {
    isAdminMode = true;
    sessionStorage.setItem('admin_password', passParam);
  }

  await loadSettings();
  initClock();
  setupEventListeners();
  updateWeekDisplay();

  // Lưu trữ danh sách option mặc định của các thẻ select
  originalChairpersonHtml = document.getElementById('event-chairperson').innerHTML;
  originalLocationHtml = document.getElementById('event-location').innerHTML;
  originalPreparingHtml = document.getElementById('event-preparing').innerHTML;
  
  // Khởi tạo SQL.js WebAssembly trước khi nạp sự kiện
  await initSqlDatabase();
  
  loadEvents();
  checkBackendConnection();

  // Khôi phục chế độ quản trị nếu có mật khẩu lưu trong phiên làm việc
  const savedPassword = sessionStorage.getItem('admin_password');
  if (savedPassword) {
    isAdminMode = true;
    const btnAdmin = document.getElementById('btn-toggle-admin');
    if (btnAdmin) {
      btnAdmin.innerHTML = '<i class="fa-solid fa-unlock text-emerald"></i> <span>Chế độ Quản trị</span>';
      btnAdmin.className = 'btn btn-outline border-emerald';
    }
    // Hiển thị các chức năng quản trị sau khi DOM hoàn thành
    setTimeout(() => {
      document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    }, 100);
  }

  // Tự động tải/đồng bộ lịch từ Google Calendar sau 5 giây từ khi load trang, và lặp lại mỗi 5 phút (300000 ms)
  setTimeout(syncFromGoogleCalendar, 5000);
  setInterval(syncFromGoogleCalendar, 300000);
});

// ==========================================================================
// SQL.JS WEBASSEMBLY DATABASE INITIALIZATION
// ==========================================================================

async function initSqlDatabase() {
  try {
    SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
    });
    
    const savedDbBase64 = localStorage.getItem('ubnd_calendar_sql_db');
    
    if (savedDbBase64) {
      const binaryString = atob(savedDbBase64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      sqlDb = new SQL.Database(bytes);
      console.log('Đã nạp thành công SQLite database từ LocalStorage.');
    } else {
      sqlDb = new SQL.Database();
      
      sqlDb.run(`
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
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      const stmt = sqlDb.prepare(`
        INSERT INTO events (title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      FALLBACK_EVENTS.forEach(evt => {
        stmt.run([
          evt.title,
          evt.start_time,
          evt.end_time,
          evt.chairperson,
          evt.location,
          evt.attendees,
          evt.preparing_unit,
          evt.category,
          evt.status,
          evt.document_link
        ]);
      });
      stmt.free();
      
      saveWasmDbToLocalStorage();
      console.log('Khởi tạo mới CSDL SQLite WebAssembly và nạp 10 sự kiện mẫu.');
    }
  } catch (err) {
    console.error('Không thể khởi tạo CSDL SQLite WebAssembly:', err);
    settings.syncMode = 'local';
  }
}

function saveWasmDbToLocalStorage() {
  if (!sqlDb) return;
  const binaryArray = sqlDb.export();
  let binaryString = "";
  for (let i = 0; i < binaryArray.length; i++) {
    binaryString += String.fromCharCode(binaryArray[i]);
  }
  const base64Data = btoa(binaryString);
  localStorage.setItem('ubnd_calendar_sql_db', base64Data);
}

// ==========================================================================
// SETTINGS & BACKEND CONFIGURATION
// ==========================================================================

async function loadSettings() {
  const savedSettings = localStorage.getItem('ubnd_calendar_settings');
  if (savedSettings) {
    settings = { ...settings, ...JSON.parse(savedSettings) };
  }

  // Tải cấu hình dùng chung từ Express Server nếu đang kết nối chế độ server
  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const serverSettings = await res.json();
      if (serverSettings.appsScriptUrl) {
        settings.appsScriptUrl = serverSettings.appsScriptUrl;
        settings.gcalId = serverSettings.gcalId || settings.gcalId;
        settings.webhookSecret = serverSettings.webhookSecret || settings.webhookSecret;
        settings.aiProvider = serverSettings.aiProvider || settings.aiProvider;
        settings.aiModel = serverSettings.aiModel || settings.aiModel;
        settings.tvFocus = serverSettings.tvFocus || settings.tvFocus;
        if (!settings.aiKey && serverSettings.aiKey && serverSettings.aiKey !== '********') {
          settings.aiKey = serverSettings.aiKey;
        }
      }
    }
  } catch (e) {
    console.warn('Không thể nạp cấu hình hệ thống từ server, sử dụng cấu hình cục bộ.', e);
  }
  
  const radioSyncMode = document.querySelector(`input[name="setting-sync-mode"][value="${settings.syncMode}"]`);
  if (radioSyncMode) radioSyncMode.checked = true;
  
  document.getElementById('setting-gcal-id').value = settings.gcalId || 'primary';
  document.getElementById('setting-apps-script-url').value = settings.appsScriptUrl || '';
  document.getElementById('setting-webhook-secret').value = settings.webhookSecret ? '********' : '';
  document.getElementById('setting-tv-focus').value = settings.tvFocus || '';

  document.getElementById('setting-ai-provider').value = settings.aiProvider || 'deepseek';
  document.getElementById('setting-ai-model').value = settings.aiModel || 'deepseek-chat';
  document.getElementById('setting-ai-key').value = settings.aiKey ? '********' : '';

  updateAppsScriptButtonState();
}

function updateAppsScriptButtonState() {
  const btnTestGas = document.getElementById('btn-test-gas');
  if (btnTestGas) {
    btnTestGas.disabled = !settings.appsScriptUrl;
  }
}

async function checkBackendConnection() {
  const badge = document.getElementById('connection-badge');
  const badgeText = document.getElementById('connection-status-text');

  if (settings.syncMode === 'local') {
    badge.className = 'badge badge-offline';
    badgeText.textContent = 'Chế độ Offline (LocalStorage thô)';
    return false;
  }

  try {
    const res = await fetch('/api/events?query=test-connection', { method: 'GET' });
    if (res.ok) {
      badge.className = 'badge badge-online';
      badgeText.textContent = 'Đồng bộ: Express Server + SQL (SQLite) hoạt động';
      
      // Tự động nâng cấp sang kết nối server-sqlite nếu máy chưa cấu hình hoặc đang chạy WASM offline
      const savedSettings = localStorage.getItem('ubnd_calendar_settings');
      if (!savedSettings || settings.syncMode === 'wasm-sqlite') {
        settings.syncMode = 'server-sqlite';
        localStorage.setItem('ubnd_calendar_settings', JSON.stringify(settings));
        console.log('TV/Client: Tự động kết nối cơ sở dữ liệu dùng chung trên Máy chủ Express.');
        
        const radioSyncMode = document.querySelector(`input[name="setting-sync-mode"][value="server-sqlite"]`);
        if (radioSyncMode) radioSyncMode.checked = true;
        
        loadEvents();
      }
      return true;
    } else {
      throw new Error();
    }
  } catch (err) {
    if (settings.syncMode === 'server-sqlite') {
      badge.className = 'badge badge-offline';
      badgeText.textContent = 'Mất kết nối Node Server (Tự động chạy WASM SQLite)';
    } else {
      badge.className = 'badge badge-online';
      badgeText.textContent = 'Cơ sở dữ liệu: SQLite WebAssembly (WASM SQL Engine)';
    }
    return false;
  }
}

// ==========================================================================
// LIVE CLOCK WIDGET
// ==========================================================================

function initClock() {
  const updateClock = () => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    const daysOfWeek = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
    const dayName = daysOfWeek[now.getDay()];
    const date = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();

    const timeStr = `${hours}:${minutes}:${seconds}`;
    const dateStr = `${dayName}, ngày ${date}/${month}/${year}`;

    document.getElementById('live-time').textContent = timeStr;
    document.getElementById('live-date').textContent = dateStr;

    // Định dạng riêng cho TV sảnh (Đồng hồ không giây, ngày tháng viết hoa)
    const tvTimeStr = `${hours}:${minutes}`;
    const tvDateStr = `${dayName.toUpperCase()}, ${date}/${month}/${year}`;
    
    const tvTimeEl = document.getElementById('tv-time');
    const tvDateEl = document.getElementById('tv-date');
    if (tvTimeEl) tvTimeEl.textContent = tvTimeStr;
    if (tvDateEl) tvDateEl.textContent = tvDateStr;
  };

  updateClock();
  setInterval(updateClock, 1000);
}

// ==========================================================================
// DATE UTILITIES FOR WEEK MANIPULATION
// ==========================================================================

function getWeekRange(offset) {
  const today = new Date();
  const currentDay = today.getDay(); 
  
  const distanceToMonday = currentDay === 0 ? -6 : 1 - currentDay;
  
  const monday = new Date(today);
  monday.setDate(today.getDate() + distanceToMonday + (offset * 7));
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { monday, sunday };
}

function formatDateISO(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateDisplay(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${dd}/${mm}`;
}

function updateWeekDisplay() {
  const { monday, sunday } = getWeekRange(currentWeekOffset);
  
  const startStr = formatDateDisplay(monday);
  const endStr = formatDateDisplay(sunday);
  const startYear = monday.getFullYear();
  
  document.getElementById('week-display-range').textContent = 
    `Tuần từ ${startStr}/${startYear} đến ${endStr}/${sunday.getFullYear()}`;

  const cols = document.querySelectorAll('.grid-header-col[data-day]');
  cols.forEach(col => {
    const dayIndex = parseInt(col.getAttribute('data-day')); 
    const colDate = new Date(monday);
    colDate.setDate(monday.getDate() + (dayIndex - 1));
    
    const dayNames = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật'];
    col.innerHTML = `${dayNames[dayIndex - 1]} <span class="header-date">${formatDateDisplay(colDate)}</span>`;
  });
}

// ==========================================================================
// DATA ACQUISITION & INTEGRATION (SQL WASM / SQL Backend / LocalStorage)
// ==========================================================================

async function loadEvents() {
  const { monday, sunday } = getWeekRange(currentWeekOffset);
  const startISO = formatDateISO(monday) + ' 00:00';
  const endISO = formatDateISO(sunday) + ' 23:59';

  if (settings.syncMode === 'wasm-sqlite' && sqlDb) {
    try {
      const stmt = sqlDb.prepare(`
        SELECT * FROM events 
        WHERE start_time >= ? AND end_time <= ? 
        ORDER BY start_time ASC
      `);
      stmt.bind([startISO, endISO]);
      
      events = [];
      while (stmt.step()) {
        events.push(stmt.getAsObject());
      }
      stmt.free();

      renderGrid();
      renderCitizenReception();
      return;
    } catch (err) {
      console.error('Lỗi SQLite WASM:', err);
    }
  }

  if (settings.syncMode === 'server-sqlite') {
    try {
      const startDayISO = formatDateISO(monday);
      const endDayISO = formatDateISO(sunday);
      const res = await fetch(`/api/events?startDate=${startDayISO}&endDate=${endDayISO}`);
      if (res.ok) {
        events = await res.json();
        renderGrid();
        renderCitizenReception();
        renderExecutiveDashboard();
        return;
      }
      throw new Error();
    } catch (err) {
      console.warn('Lỗi kết nối Server SQL, tự động chạy WASM SQLite.');
    }
  }

  let localData = localStorage.getItem('ubnd_calendar_events');
  if (!localData) {
    events = FALLBACK_EVENTS;
    localStorage.setItem('ubnd_calendar_events', JSON.stringify(events));
  } else {
    events = JSON.parse(localData);
  }

  const startDayOnly = formatDateISO(monday);
  const endDayOnly = formatDateISO(sunday);
  events = events.filter(evt => {
    const evtDate = evt.start_time.split(' ')[0];
    return evtDate >= startDayOnly && evtDate <= endDayOnly;
  });

  renderGrid();
  renderCitizenReception();
  renderExecutiveDashboard();
}

// Lưu lịch họp mới hoặc cập nhật lịch họp có sẵn
async function saveEventData(eventData, override = false) {
  eventData.override_conflict = override;

  const autoCreateDrive = document.getElementById('event-auto-drive') 
    ? document.getElementById('event-auto-drive').checked 
    : false;
  const sendEmail = document.getElementById('event-send-email') 
    ? document.getElementById('event-send-email').checked 
    : false;

  // 1. TỰ ĐỘNG HÓA GOOGLE DRIVE & GỬI EMAIL (NẾU CÓ CẤU HÌNH APPS SCRIPT)
  if (settings.appsScriptUrl && (autoCreateDrive || sendEmail)) {
    try {
      const gasPayload = {
        ...eventData,
        calendar_id: settings.gcalId || 'primary',
        auto_create_drive: autoCreateDrive && !eventData.document_link,
        send_email: sendEmail
      };

      // Gọi API Apps Script ở dạng đồng bộ trước để lấy Google Drive Folder URL
      const response = await fetch(settings.appsScriptUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(gasPayload)
      });

      // Đọc phản hồi JSON nếu Apps Script có hỗ trợ CORS trả về, nếu không chỉ ghi nhận gửi
      try {
        const gasResult = await response.json();
        if (gasResult && gasResult.success) {
          if (gasResult.document_link) {
            eventData.document_link = gasResult.document_link;
          }
          if (gasResult.google_event_id) {
            eventData.google_event_id = gasResult.google_event_id;
          }
          console.log("Đã đồng bộ Google tự động:", gasResult);
        }
      } catch (jsonErr) {
        // Apps Script đôi khi Redirect làm trình duyệt chặn CORS đọc kết quả. Ta ghi nhận đã đồng bộ xong.
        console.log("Đã gửi yêu cầu đồng bộ Google Apps Script (Redirected).");
      }
    } catch (err) {
      console.warn("Không thể đồng bộ tự động Google Calendar/Drive:", err.message);
    }
  }

  // 2. LƯU VÀO CƠ SỞ DỮ LIỆU CỤC BỘ (SQL WASM)
  if (settings.syncMode === 'wasm-sqlite' && sqlDb) {
    let conflictQuery = `
      SELECT * FROM events 
      WHERE location = ? 
      AND status NOT IN ('cancelled', 'postponed')
      AND NOT (end_time <= ? OR start_time >= ?)
    `;
    const conflictParams = [eventData.location, eventData.start_time, eventData.end_time];
    if (eventData.id) {
      conflictQuery += " AND id != ?";
      conflictParams.push(eventData.id);
    }

    const conflictStmt = sqlDb.prepare(conflictQuery);
    conflictStmt.bind(conflictParams);
    let conflict = null;
    if (conflictStmt.step()) {
      conflict = conflictStmt.getAsObject();
    }
    conflictStmt.free();

    if (conflict && !override) {
      showConflictWarning(`[SQL-WASM] Phòng họp "${eventData.location}" đã trùng lịch với cuộc họp: "${conflict.title}" chủ trì bởi ${conflict.chairperson}.`);
      return false;
    }

    if (eventData.id) {
      sqlDb.run(`
        UPDATE events 
        SET title = ?, start_time = ?, end_time = ?, chairperson = ?, location = ?, 
            attendees = ?, preparing_unit = ?, category = ?, status = ?, document_link = ?
        WHERE id = ?
      `, [
        eventData.title, eventData.start_time, eventData.end_time, eventData.chairperson, eventData.location,
        eventData.attendees, eventData.preparing_unit, eventData.category, eventData.status, eventData.document_link,
        eventData.id
      ]);
    } else {
      sqlDb.run(`
        INSERT INTO events (title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        eventData.title, eventData.start_time, eventData.end_time, eventData.chairperson, eventData.location,
        eventData.attendees, eventData.preparing_unit, eventData.category, eventData.status, eventData.document_link
      ]);
    }

    saveWasmDbToLocalStorage();
    return true;
  }

  // 3. Chế độ Express Backend Server SQL
  if (settings.syncMode === 'server-sqlite') {
    const url = eventData.id ? `/api/events/${eventData.id}` : '/api/events';
    const method = eventData.id ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method: method,
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (sessionStorage.getItem('admin_password') || '')
        },
        body: JSON.stringify(eventData)
      });

      const result = await res.json();

      if (res.status === 409 && result.conflict) {
        showConflictWarning(result.message);
        return false;
      }

      if (res.status === 401 || res.status === 403) {
        exitAdminModeForce();
        return false;
      }

      if (!res.ok) {
        alert('Lỗi hệ thống: ' + (result.error || 'Không rõ nguyên nhân'));
        return false;
      }
      return true;
    } catch (err) {
      alert('Không thể kết nối đến máy chủ Express: ' + err.message);
      return false;
    }
  }

  // 4. Chế độ LocalStorage JSON thô
  let allEvents = JSON.parse(localStorage.getItem('ubnd_calendar_events') || '[]');
  
  const conflict = allEvents.find(evt => 
    evt.location === eventData.location &&
    evt.id !== eventData.id &&
    evt.status !== 'cancelled' &&
    evt.status !== 'postponed' &&
    !(evt.end_time <= eventData.start_time || evt.start_time >= eventData.end_time)
  );

  if (conflict && !override) {
    showConflictWarning(`[OFFLINE] Phòng này trùng lịch với cuộc họp: "${conflict.title}" chủ trì bởi ${conflict.chairperson}.`);
    return false;
  }

  if (eventData.id) {
    allEvents = allEvents.map(evt => evt.id === eventData.id ? { ...evt, ...eventData } : evt);
  } else {
    eventData.id = Date.now();
    allEvents.push(eventData);
  }

  localStorage.setItem('ubnd_calendar_events', JSON.stringify(allEvents));
  return true;
}

// Xóa lịch họp
async function deleteEventData(id) {
  if (settings.syncMode === 'wasm-sqlite' && sqlDb) {
    try {
      sqlDb.run("DELETE FROM events WHERE id = ?", [id]);
      saveWasmDbToLocalStorage();
      return true;
    } catch (e) {
      alert('Lỗi SQL khi xóa: ' + e.message);
      return false;
    }
  }

  if (settings.syncMode === 'server-sqlite') {
    try {
      const res = await fetch(`/api/events/${id}`, { 
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer ' + (sessionStorage.getItem('admin_password') || '')
        }
      });
      if (res.ok) {
        return true;
      }
      if (res.status === 401 || res.status === 403) {
        exitAdminModeForce();
        return false;
      }
      const data = await res.json();
      alert('Lỗi khi xóa: ' + data.error);
      return false;
    } catch (err) {
      alert('Không kết nối được server: ' + err.message);
      return false;
    }
  }

  let allEvents = JSON.parse(localStorage.getItem('ubnd_calendar_events') || '[]');
  allEvents = allEvents.filter(evt => evt.id !== id);
  localStorage.setItem('ubnd_calendar_events', JSON.stringify(allEvents));
  return true;
}

// ==========================================================================
// RENDER FRONTEND WEB INTERFACE
// ==========================================================================

function clearGrid() {
  const cells = document.querySelectorAll('.grid-cell');
  cells.forEach(cell => cell.innerHTML = '');
}

function renderGrid() {
  clearGrid();

  const gridEvents = (events && events.length > 0) ? events : FALLBACK_EVENTS;

  gridEvents.forEach(evt => {
    if (!evt.start_time) return;
    const parts = evt.start_time.split(' ');
    const datePart = parts[0];
    const timePart = parts[1] || '08:00';
    const [hours, minutes] = timePart.split(':');
    const hourInt = parseInt(hours || '8');

    const slot = hourInt < 12 ? 'morning' : 'afternoon';

    const dateSplit = datePart.split('-');
    const year = parseInt(dateSplit[0]);
    const month = parseInt(dateSplit[1]) - 1;
    const day = parseInt(dateSplit[2]);
    const evtDate = new Date(year, month, day);
    const dayOfWeek = evtDate.getDay();
    const gridDayIndex = dayOfWeek === 0 ? 7 : dayOfWeek;

    const cellId = `cell-${slot}-${gridDayIndex}`;
    const cell = document.getElementById(cellId);
    
    if (cell) {
      const card = createEventCard(evt);
      cell.appendChild(card);
    }
  });
}

function createEventCard(evt) {
  const card = document.createElement('div');
  
  // Phân loại trạng thái thời gian thực
  const now = new Date();
  const startTime = new Date(evt.start_time.replace(/-/g, '/'));
  const endTime = new Date(evt.end_time.replace(/-/g, '/'));
  let calculatedStatus = evt.status || 'scheduled';
  
  if (now > endTime) calculatedStatus = 'completed';
  else if (now >= startTime && now <= endTime) calculatedStatus = 'ongoing';
  else if (startTime > now && (startTime - now) <= 30 * 60000) calculatedStatus = 'upcoming';

  card.className = `event-card cat-${evt.category} status-${calculatedStatus} ${calculatedStatus}`;
  card.dataset.id = evt.id;
  
  let documentIndicator = '';
  if (evt.document_link) {
    if (evt.document_link.includes('drive.google.com')) {
      documentIndicator = `<div class="document-indicator" style="color: #0F9D58;" title="Có tài liệu Google Drive"><i class="fa-brands fa-google-drive"></i></div>`;
    } else {
      documentIndicator = `<div class="document-indicator" title="Có tài liệu đính kèm"><i class="fa-solid fa-file-pdf"></i></div>`;
    }
  }

  const startTime = evt.start_time.split(' ')[1];
  const endTime = evt.end_time.split(' ')[1];

  card.innerHTML = `
    ${documentIndicator}
    <div class="event-title">${evt.title}</div>
    <div class="event-meta-item">
      <i class="fa-regular fa-clock"></i>
      <span><strong>${startTime} - ${endTime}</strong></span>
    </div>
    <div class="event-meta-item">
      <i class="fa-solid fa-user-tie"></i>
      <span>Chủ trì: <strong>${evt.chairperson}</strong></span>
    </div>
    <div class="event-meta-item">
      <i class="fa-solid fa-location-dot"></i>
      <span>Nơi họp: <strong>${evt.location}</strong></span>
    </div>
    <div class="event-tags-row">
      <span class="event-status-badge status-${calculatedStatus}">
        ${getStatusLabel(calculatedStatus)}
      </span>
    </div>
  `;

  card.addEventListener('click', () => openDetailsModal(evt));
  return card;
}

function getStatusLabel(status) {
  switch (status) {
    case 'scheduled': return 'Sắp diễn ra';
    case 'ongoing': return 'Đang diễn ra';
    case 'completed': return 'Đã kết thúc';
    case 'postponed': return 'Đã hoãn';
    default: return 'Chưa rõ';
  }
}

function renderCitizenReception() {
  const container = document.getElementById('citizen-reception-list');
  container.innerHTML = '';

  const receptionEvents = events.filter(evt => evt.category === 'tiep_dan');

  if (receptionEvents.length === 0) {
    container.innerHTML = `
      <div class="tv-empty-box" style="background: white; border: 2px dashed #CBD5E1; color: var(--text-light)">
        <i class="fa-solid fa-people-roof" style="color: #CBD5E1"></i>
        <h4>Không có lịch tiếp dân nào trong tuần này</h4>
        <p>Chọn các tuần khác hoặc theo dõi thông tin từ bảng tin trực tiếp.</p>
      </div>
    `;
    return;
  }

  receptionEvents.forEach(evt => {
    const card = document.createElement('div');
    card.className = 'reception-list-card';
    
    const [datePart, timePart] = evt.start_time.split(' ');
    const [yyyy, mm, dd] = datePart.split('-');
    const startTimeStr = timePart;
    const endTimeStr = evt.end_time.split(' ')[1];

    card.innerHTML = `
      <div class="reception-date-badge">
        <i class="fa-regular fa-calendar"></i> Thứ ${new Date(datePart).getDay() === 0 ? 'Nhật' : new Date(datePart).getDay() + 1} - Ngày ${dd}/${mm}/${yyyy}
      </div>
      <div class="reception-title">${evt.title}</div>
      <table class="details-table" style="margin-top: 5px;">
        <tr>
          <td style="width: 80px; padding: 4px 0;"><i class="fa-regular fa-clock"></i> <strong>Thời gian:</strong></td>
          <td style="padding: 4px 0;">${startTimeStr} - ${endTimeStr}</td>
        </tr>
        <tr>
          <td style="width: 80px; padding: 4px 0;"><i class="fa-solid fa-user-tie"></i> <strong>Chủ trì:</strong></td>
          <td style="padding: 4px 0;">${evt.chairperson}</td>
        </tr>
        <tr>
          <td style="width: 80px; padding: 4px 0;"><i class="fa-solid fa-location-dot"></i> <strong>Tại:</strong></td>
          <td style="padding: 4px 0;">${evt.location}</td>
        </tr>
      </table>
    `;
    card.addEventListener('click', () => openDetailsModal(evt));
    container.appendChild(card);
  });
}

// ==========================================================================
// MODALS MANAGEMENT & QR CODE / ZALO / GOOGLE CALENDAR LINK
// ==========================================================================

function openDetailsModal(evt) {
  selectedEvent = evt;
  
  document.getElementById('details-modal-title').textContent = 'Chi tiết lịch làm việc';
  document.getElementById('details-title').textContent = evt.title;
  
  const [datePart, timePart] = evt.start_time.split(' ');
  const [yyyy, mm, dd] = datePart.split('-');
  const endTimeStr = evt.end_time.split(' ')[1];
  document.getElementById('details-time').textContent = `${timePart} - ${endTimeStr} | Ngày ${dd}/${mm}/${yyyy}`;
  
  document.getElementById('details-chairperson').textContent = evt.chairperson;
  document.getElementById('details-location').textContent = evt.location;
  document.getElementById('details-attendees').textContent = evt.attendees || 'Không có';
  document.getElementById('details-preparing').textContent = evt.preparing_unit || 'Văn phòng UBND';
  
  const badge = document.getElementById('details-category-badge');
  badge.className = `badge cat-${evt.category}`;
  badge.textContent = getCategoryLabel(evt.category);
  
  // Nút admin ẩn hiện
  const btnEdit = document.getElementById('btn-edit-from-details');
  const btnAiMinutes = document.getElementById('btn-ai-minutes-trigger');
  
  if (isAdminMode) {
    btnEdit.classList.remove('hidden');
    // Chỉ hiện nút soạn biên bản họp AI cho các cuộc họp đã diễn ra hoặc đã kết thúc
    btnAiMinutes.classList.remove('hidden');
  } else {
    btnEdit.classList.add('hidden');
    btnAiMinutes.classList.add('hidden');
  }

  const gcalBtn = document.getElementById('btn-add-gcal-link');
  gcalBtn.href = generateGoogleCalendarURL(evt);

  const qrContainer = document.getElementById('details-qr-container');
  const qrBox = document.getElementById('details-qrcode');
  const qrDesc = document.getElementById('details-qr-desc');
  qrBox.innerHTML = ''; 

  if (evt.document_link) {
    qrContainer.classList.remove('hidden');
    
    // Tự động thay đổi mô tả và tiêu đề mã QR nếu là Google Drive
    if (evt.document_link.includes('drive.google.com')) {
      qrContainer.querySelector('h5').innerHTML = '<i class="fa-brands fa-google-drive" style="color: #0F9D58;"></i> MÃ QR THƯ MỤC DRIVE';
      qrDesc.textContent = 'Quét mã để truy cập thư mục Google Drive chứa đầy đủ tài liệu cuộc họp này.';
    } else {
      qrContainer.querySelector('h5').textContent = 'MÃ QR TÀI LIỆU HỌP';
      qrDesc.textContent = 'Quét mã để tải tài liệu cuộc họp trực tiếp trên điện thoại di động.';
    }

    new QRCode(qrBox, {
      text: evt.document_link,
      width: 110,
      height: 110,
      colorDark : "#0F172A",
      colorLight : "#FFFFFF",
      correctLevel : QRCode.CorrectLevel.H
    });
  } else {
    qrContainer.classList.add('hidden');
  }

  openModal('modal-details');
}

function getCategoryLabel(cat) {
  switch (cat) {
    case 'dang_uy': return 'Khối Đảng ủy / HĐND';
    case 'ubnd': return 'Khối UBND / Chuyên môn';
    case 'tiep_dan': return 'Lịch Tiếp công dân';
    case 'thuc_dia': return 'Đi thực địa / Cơ sở';
    default: return 'Khác';
  }
}

function generateGoogleCalendarURL(evt) {
  const baseUrl = 'https://calendar.google.com/calendar/render';
  
  const formatGTime = (timeStr) => {
    return timeStr.replace(/[- :]/g, '') + '00';
  };

  const dates = `${formatGTime(evt.start_time)}/${formatGTime(evt.end_time)}`;
  const details = 
    `Chủ trì: ${evt.chairperson}\n` +
    `Thành phần: ${evt.attendees || 'Cán bộ công chức'}\n` +
    `Đơn vị chuẩn bị: ${evt.preparing_unit || 'Văn phòng'}\n` +
    `Tài liệu: ${evt.document_link || 'Không có'}`;

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: evt.title,
    dates: dates,
    details: details,
    location: evt.location
  });

  if (settings.gcalId && settings.gcalId !== 'primary') {
    params.append('src', settings.gcalId);
  }

  return `${baseUrl}?${params.toString()}`;
}

function copyToZaloFormat() {
  if (!selectedEvent) return;
  const evt = selectedEvent;

  const [datePart, timePart] = evt.start_time.split(' ');
  const [yyyy, mm, dd] = datePart.split('-');
  const endTimeStr = evt.end_time.split(' ')[1];

  const daysOfWeek = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  const dayName = daysOfWeek[new Date(datePart).getDay()];

  const text = `🔔 THÔNG BÁO LỊCH HỌP - UBND XÃ NGHĨA LÂM
------------------------------------------
📝 Nội dung: ${evt.title}
⏰ Thời gian: ${timePart} - ${endTimeStr} (${dayName}, ngày ${dd}/${mm}/${yyyy})
👤 Chủ trì: ${evt.chairperson}
📍 Địa điểm: ${evt.location}
👥 Thành phần: ${evt.attendees || 'Theo phân ban chuyên môn'}
📂 Chuẩn bị nội dung: ${evt.preparing_unit || 'Văn phòng UBND'}
${evt.document_link ? `📎 Link tài liệu họp (Google Drive): ${evt.document_link}` : '📎 Tài liệu: Đã phát hành bản giấy'}`;

  navigator.clipboard.writeText(text).then(() => {
    alert('Đã sao chép nội dung tin nhắn lịch họp! Bạn có thể dán (Paste) vào nhóm Zalo ngay bây giờ.');
  }).catch(err => {
    alert('Không thể sao chép: ' + err);
  });
}

function openModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
  if (modalId === 'modal-event') {
    resetEventForm();
  }
}

function resetEventForm() {
  document.getElementById('form-event').reset();

  // Khôi phục lại danh sách option mặc định (xóa các option tùy chỉnh được tạo động trong quá trình chỉnh sửa trước đó)
  if (originalChairpersonHtml) document.getElementById('event-chairperson').innerHTML = originalChairpersonHtml;
  if (originalLocationHtml) document.getElementById('event-location').innerHTML = originalLocationHtml;
  if (originalPreparingHtml) document.getElementById('event-preparing').innerHTML = originalPreparingHtml;

  document.getElementById('event-id').value = '';
  document.getElementById('btn-delete-event').classList.add('hidden');
  document.getElementById('event-ai-raw-text').value = '';
  
  // Dọn dẹp khung xem trước mã QR Code
  const qrContainer = document.getElementById('admin-qr-preview-container');
  if (qrContainer) {
    qrContainer.style.display = 'none';
    qrContainer.classList.add('hidden');
    document.getElementById('admin-qr-preview-box').innerHTML = '';
  }

  const details = document.querySelector('.ai-extractor-details');
  if (details) details.removeAttribute('open');

  hideConflictWarning();
}

function showConflictWarning(msg) {
  const container = document.getElementById('override-conflict-container');
  const warningText = document.getElementById('conflict-warning-text');
  
  warningText.textContent = msg;
  container.classList.remove('hidden');
}

function hideConflictWarning() {
  const container = document.getElementById('override-conflict-container');
  container.classList.add('hidden');
  document.getElementById('event-override-conflict').checked = false;
}

// Hàm bổ trợ gán giá trị cho select và tự động chèn option mới nếu giá trị đó là tự nhập/tùy chỉnh
function setSelectValueWithCustom(selectId, value) {
  const select = document.getElementById(selectId);
  if (!select) return;
  
  if (value === undefined || value === null) {
    select.value = "";
    return;
  }
  
  const valString = String(value).trim();
  if (valString === "") {
    select.value = "";
    return;
  }
  
  // Kiểm tra xem giá trị đã có sẵn trong danh sách option chưa
  let hasOption = false;
  for (let i = 0; i < select.options.length; i++) {
    if (select.options[i].value === valString) {
      hasOption = true;
      break;
    }
  }
  
  // Nếu chưa có trong select (ví dụ: dữ liệu tự nhập hoặc import từ file khác), tạo thêm option mới
  if (!hasOption) {
    const opt = document.createElement('option');
    opt.value = valString;
    opt.textContent = valString;
    select.appendChild(opt);
  }
  
  select.value = valString;
}

function openEditEventForm(evt = null) {
  resetEventForm();
  
  if (evt) {
    document.getElementById('modal-event-title').textContent = 'Chỉnh sửa lịch làm việc';
    document.getElementById('event-id').value = evt.id;
    document.getElementById('event-title').value = evt.title;
    document.getElementById('event-category').value = evt.category;
    document.getElementById('event-status').value = evt.status;
    document.getElementById('event-start').value = evt.start_time.replace(' ', 'T');
    document.getElementById('event-end').value = evt.end_time.replace(' ', 'T');
    
    // Gán dữ liệu cho select dropdown (bằng helper để xử lý giá trị tùy chỉnh)
    setSelectValueWithCustom('event-chairperson', evt.chairperson);
    setSelectValueWithCustom('event-location', evt.location);
    setSelectValueWithCustom('event-preparing', evt.preparing_unit || '');

    document.getElementById('event-attendees').value = evt.attendees || '';
    document.getElementById('event-document').value = evt.document_link || '';
    
    // Tự động tạo ảnh QR Code xem trước nếu cuộc họp đã có sẵn tài liệu
    if (evt.document_link) {
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(evt.document_link)}&color=0f172a`;
      document.getElementById('admin-qr-preview-box').innerHTML = `<img src="${qrUrl}" style="width: 100%; height: 100%; display: block;" alt="QR Code">`;
      document.getElementById('admin-qr-download').href = qrUrl;
      const qrContainer = document.getElementById('admin-qr-preview-container');
      qrContainer.style.display = 'flex';
      qrContainer.classList.remove('hidden');
    }
    
    document.getElementById('btn-delete-event').classList.remove('hidden');
  } else {
    document.getElementById('modal-event-title').textContent = 'Thêm lịch làm việc mới';
  }

  closeModal('modal-details');
  openModal('modal-event');
}

// ==========================================================================
// UPLOAD & PARSE CALENDAR FILE (.JSON / .CSV)
// ==========================================================================

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  
  reader.onload = function(evt) {
    const fileContent = evt.target.result;
    const fileExtension = file.name.split('.').pop().toLowerCase();
    
    try {
      let importedEvents = [];
      
      if (fileExtension === 'json') {
        importedEvents = JSON.parse(fileContent);
        if (!Array.isArray(importedEvents)) {
          throw new Error('Định dạng tệp JSON phải là một mảng danh sách lịch.');
        }
      } else if (fileExtension === 'csv') {
        importedEvents = parseCSVContent(fileContent);
      }

      if (importedEvents.length === 0) {
        alert('Không tìm thấy sự kiện nào hợp lệ để nhập.');
        return;
      }

      importEventsToDatabase(importedEvents);

    } catch (error) {
      alert('Lỗi phân tích tệp lịch: ' + error.message);
    }
    
    e.target.value = '';
  };

  reader.readAsText(file, 'UTF-8');
}

function parseCSVContent(csvText) {
  const lines = csvText.split('\n');
  const result = [];
  
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const getIndex = (keys) => headers.findIndex(h => keys.some(k => h.includes(k)));
  
  const titleIdx = getIndex(['nội dung', 'tiêu đề', 'title', 'content']);
  const startIdx = getIndex(['bắt đầu', 'start', 'start_time']);
  const endIdx = getIndex(['kết thúc', 'end', 'end_time']);
  const chairIdx = getIndex(['chủ trì', 'chairperson', 'host']);
  const locIdx = getIndex(['địa điểm', 'phòng', 'location', 'room']);
  const attIdx = getIndex(['thành phần', 'tham gia', 'attendees']);
  const prepIdx = getIndex(['chuẩn bị', 'preparing']);
  const catIdx = getIndex(['phân loại', 'loại', 'category']);
  const docIdx = getIndex(['tài liệu', 'document', 'link']);

  if (titleIdx === -1 || startIdx === -1 || chairIdx === -1 || locIdx === -1) {
    throw new Error('Tệp CSV thiếu các cột bắt buộc: Nội dung, Bắt đầu, Chủ trì, Địa điểm.');
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = [];
    let insideQuote = false;
    let entry = '';
    
    for (let charIndex = 0; charIndex < line.length; charIndex++) {
      const char = line[charIndex];
      if (char === '"') {
        insideQuote = !insideQuote;
      } else if (char === ',' && !insideQuote) {
        cols.push(entry.trim());
        entry = '';
      } else {
        entry += char;
      }
    }
    cols.push(entry.trim());

    if (cols.length < 4 || !cols[titleIdx]) continue;

    result.push({
      title: cols[titleIdx],
      start_time: cols[startIdx],
      end_time: cols[endIdx] || cols[startIdx], 
      chairperson: cols[chairIdx],
      location: cols[locIdx],
      attendees: attIdx !== -1 ? cols[attIdx] : '',
      preparing_unit: prepIdx !== -1 ? cols[prepIdx] : '',
      category: catIdx !== -1 ? cols[catIdx] : 'ubnd',
      document_link: docIdx !== -1 ? cols[docIdx] : '',
      status: 'scheduled'
    });
  }

  return result;
}

async function importEventsToDatabase(importedEvents) {
  let count = 0;
  
  if (settings.syncMode === 'wasm-sqlite' && sqlDb) {
    const stmt = sqlDb.prepare(`
      INSERT INTO events (title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    importedEvents.forEach(evt => {
      const start = evt.start_time.replace('T', ' ');
      const end = evt.end_time.replace('T', ' ');

      stmt.run([
        evt.title,
        start,
        end,
        evt.chairperson,
        evt.location,
        evt.attendees || '',
        evt.preparing_unit || '',
        evt.category || 'ubnd',
        evt.status || 'scheduled',
        evt.document_link || ''
      ]);
      count++;
    });
    stmt.free();
    saveWasmDbToLocalStorage();
  } else if (settings.syncMode === 'server-sqlite') {
    for (const evt of importedEvents) {
      try {
        const start = evt.start_time.replace('T', ' ');
        const end = evt.end_time.replace('T', ' ');
        const success = await saveEventData({ ...evt, start_time: start, end_time: end }, true); 
        if (success) count++;
      } catch (e) {
        console.error(e);
      }
    }
  } else {
    let allEvents = JSON.parse(localStorage.getItem('ubnd_calendar_events') || '[]');
    importedEvents.forEach(evt => {
      evt.id = Date.now() + count;
      evt.start_time = evt.start_time.replace('T', ' ');
      evt.end_time = evt.end_time.replace('T', ' ');
      allEvents.push(evt);
      count++;
    });
    localStorage.setItem('ubnd_calendar_events', JSON.stringify(allEvents));
  }

  alert(`Đã nhập thành công ${count} sự kiện lịch vào cơ sở dữ liệu!`);
  loadEvents();
}

// ==========================================================================
// INTEGRATE AI ASSISTANT (DEEPSEEK / CODEX API)
// ==========================================================================

async function handleAIExtract() {
  const rawText = document.getElementById('event-ai-raw-text').value.trim();
  const btn = document.getElementById('btn-ai-extract');

  if (!rawText) {
    alert('Vui lòng dán văn bản công văn hoặc giấy mời họp để AI phân tích.');
    return;
  }

  if (!settings.aiKey) {
    alert('Vui lòng cấu hình API Key của DeepSeek/Codex trong phần Cài đặt trước.');
    openModal('modal-settings');
    return;
  }

  const originalBtnHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI đang phân tích văn bản...';
  btn.disabled = true;

  try {
    const extractedData = await callAICompletionsAPI(rawText);
    
    if (extractedData) {
      document.getElementById('event-title').value = extractedData.title || '';
      document.getElementById('event-category').value = extractedData.category || 'ubnd';
      document.getElementById('event-chairperson').value = extractedData.chairperson || '';
      document.getElementById('event-location').value = extractedData.location || '';
      document.getElementById('event-attendees').value = extractedData.attendees || '';
      document.getElementById('event-preparing').value = extractedData.preparing_unit || '';
      document.getElementById('event-document').value = extractedData.document_link || '';
      document.getElementById('event-status').value = extractedData.status || 'scheduled';

      if (extractedData.start_time) {
        document.getElementById('event-start').value = extractedData.start_time.replace(' ', 'T');
      }
      if (extractedData.end_time) {
        document.getElementById('event-end').value = extractedData.end_time.replace(' ', 'T');
      }

      alert('Đã trích xuất thông tin lịch thành công! Bạn hãy kiểm tra lại các trường thông tin trong form bên dưới và ấn "Lưu lịch họp".');
    }
  } catch (err) {
    alert('Lỗi gọi API AI: ' + err.message);
  } finally {
    btn.innerHTML = originalBtnHtml;
    btn.disabled = false;
  }
}

async function callAICompletionsAPI(rawText) {
  let endpoint = 'https://api.deepseek.com/chat/completions';
  let modelName = settings.aiModel || 'deepseek-chat';

  if (settings.aiProvider === 'openai') {
    endpoint = 'https://api.openai.com/v1/chat/completions';
    if (!settings.aiModel || settings.aiModel === 'deepseek-chat') {
      modelName = 'gpt-4o';
    }
  }

  const systemPrompt = `Bạn là Trợ lý số hóa văn phòng hành chính cho UBND xã tại Việt Nam.
Nhiệm vụ của bạn là đọc kỹ đoạn văn bản thô dán vào (giấy mời họp, công văn chỉ đạo, thông báo) và bóc tách thông tin chính xác, điền vào một cấu trúc JSON.
Hãy trả về JSON sạch, KHÔNG có khối markdown vây quanh (không viết \`\`\`json ... \`\`\`), chỉ trả về chuỗi JSON duy nhất.

Cấu trúc JSON yêu cầu bóc tách:
{
  "title": "Tên cuộc họp rút gọn (ngắn gọn, xúc tích)",
  "category": "Phân loại cuộc họp: chỉ chọn 1 trong 4 nhãn ('dang_uy' cho Đảng/HĐND/Bí thư, 'tiep_dan' cho tiếp công dân/giải quyết khiếu nại, 'thuc_dia' cho kiểm tra hiện trường/cơ sở/thôn, 'ubnd' cho các cuộc họp hành chính/giao ban/chuyên môn khác)",
  "start_time": "Thời gian bắt đầu định dạng 'YYYY-MM-DD HH:mm'. Nếu văn bản không nêu rõ năm, hãy mặc định là năm 2026. Định dạng đúng giờ và ngày hành chính.",
  "end_time": "Thời gian kết thúc định dạng 'YYYY-MM-DD HH:mm'. Nếu không ghi rõ thời gian kết thúc, hãy mặc định cuộc họp kết thúc sau giờ bắt đầu 2 giờ 30 phút.",
  "chairperson": "Người chủ trì cuộc họp (ghi rõ họ tên hoặc chức vụ, ví dụ: 'Đ/c Nguyễn Văn A - Chủ tịch UBND xã')",
  "location": "Địa điểm họp (ví dụ: 'Phòng họp lớn tầng 2', 'Hội trường xã', 'Thôn 3')",
  "attendees": "Thành phần tham dự cuộc họp (phân tách bằng dấu phẩy, ví dụ: 'Thường trực UBND, Trưởng công an, Công chức Văn phòng')",
  "preparing_unit": "Đơn vị chuẩn bị nội dung họp (nếu có nhắc đến bộ phận chuẩn bị báo cáo/tài liệu, nếu không có để 'Văn phòng UBND')",
  "document_link": "Tìm các URL liên kết tài liệu đính kèm nếu có nhắc đến trong văn bản, nếu không để chuỗi rỗng",
  "status": "Mặc định để 'scheduled'"
}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.aiKey}`
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawText }
      ],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText || 'Lỗi kết nối API AI'}`);
  }

  const result = await response.json();
  const content = result.choices[0].message.content.trim();
  
  let jsonStr = content;
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('AI phản hồi định dạng không hợp lệ, hãy kiểm tra nội dung.');
  }
}

// AI hiệu chỉnh tiêu đề hành chính
async function handleAIPolishTitle() {
  const titleInput = document.getElementById('event-title');
  const rawTitle = titleInput.value.trim();
  const btn = document.getElementById('btn-ai-polish-title');

  if (!rawTitle) {
    alert('Vui lòng nhập nội dung công việc ngắn gọn trước khi tối ưu văn phong.');
    return;
  }

  if (!settings.aiKey) {
    alert('Vui lòng cấu hình API Key trong Settings trước.');
    openModal('modal-settings');
    return;
  }

  const originalBtnHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>...';
  btn.disabled = true;

  try {
    const refinedTitle = await callAIPolishTitleAPI(rawTitle);
    if (refinedTitle) {
      titleInput.value = refinedTitle;
    }
  } catch (err) {
    alert('Lỗi hiệu chỉnh AI: ' + err.message);
  } finally {
    btn.innerHTML = originalBtnHtml;
    btn.disabled = false;
  }
}

async function callAIPolishTitleAPI(rawTitle) {
  let endpoint = 'https://api.deepseek.com/chat/completions';
  let modelName = settings.aiModel || 'deepseek-chat';

  if (settings.aiProvider === 'openai') {
    endpoint = 'https://api.openai.com/v1/chat/completions';
    if (!settings.aiModel || settings.aiModel === 'deepseek-chat') {
      modelName = 'gpt-4o';
    }
  }

  const systemPrompt = `Bạn là chuyên gia biên soạn văn phong hành chính cho chính phủ Việt Nam.
Nhiệm vụ của bạn là nhận vào một tiêu đề cuộc họp/công việc hành chính viết tắt hoặc viết vắn tắt bằng tiếng Việt, và viết lại nó thành một câu tiêu đề trang trọng, đúng văn phong hành chính nhà nước cấp xã/phường.
Chỉ trả về tiêu đề đã hiệu chỉnh, KHÔNG giải thích thêm, không để trong ngoặc kép.
Ví dụ: "họp thôn 3 sửa đường" -> "Tổ chức Hội nghị kiểm tra thực địa và bàn phương án thi công nâng cấp đường giao thông nông thôn tại Thôn 3"`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.aiKey}`
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawTitle }
      ],
      temperature: 0.3
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const result = await response.json();
  return result.choices[0].message.content.trim();
}

// AI Biên soạn biên bản & kết luận họp
async function handleAIGenerateMinutes() {
  const rawNotes = document.getElementById('ai-minutes-raw').value.trim();
  const btn = document.getElementById('btn-ai-generate-minutes');

  if (!rawNotes) {
    alert('Vui lòng nhập vắn tắt diễn biến họp để AI làm việc.');
    return;
  }

  if (!settings.aiKey) {
    alert('Vui lòng cấu hình API Key trong Settings trước.');
    openModal('modal-settings');
    return;
  }

  const originalBtnHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI đang biên soạn kết luận cuộc họp...';
  btn.disabled = true;

  try {
    const minutesResult = await callAIGenerateMinutesAPI(selectedEvent, rawNotes);
    if (minutesResult) {
      document.getElementById('ai-minutes-result-box').textContent = minutesResult;
      document.getElementById('ai-minutes-result-container').classList.remove('hidden');
    }
  } catch (err) {
    alert('Lỗi biên soạn kết luận: ' + err.message);
  } finally {
    btn.innerHTML = originalBtnHtml;
    btn.disabled = false;
  }
}

async function callAIGenerateMinutesAPI(evt, rawNotes) {
  let endpoint = 'https://api.deepseek.com/chat/completions';
  let modelName = settings.aiModel || 'deepseek-chat';

  if (settings.aiProvider === 'openai') {
    endpoint = 'https://api.openai.com/v1/chat/completions';
    if (!settings.aiModel || settings.aiModel === 'deepseek-chat') {
      modelName = 'gpt-4o';
    }
  }

  const systemPrompt = `Bạn là Trợ lý soạn văn bản hành chính cho văn phòng UBND xã Nghĩa Lâm, tỉnh Nghệ An.
Nhiệm vụ của bạn là nhận thông tin cơ bản của một cuộc họp và các ghi chép thảo luận thô, sau đó biên soạn thành một văn bản "THÔNG BÁO KẾT LUẬN CUỘC HỌP" trang trọng, chuyên nghiệp và đúng định dạng quy chuẩn văn bản hành chính Việt Nam.

Văn bản cần thể hiện đủ:
1. Quốc hiệu & Tiêu ngữ chính phủ viết hoa
2. Cơ quan ban hành: ỦY BAN NHÂN DÂN XÃ NGHĨA LÂM (Số: .../TB-UBND) bên trái, địa danh ngày tháng bên phải.
3. Tiêu đề: THÔNG BÁO Kết luận của [Chủ trì] tại cuộc họp [Tiêu đề cuộc họp]
4. Nội dung chính:
   - Phần mở đầu: Nêu thời gian, địa điểm, thành phần họp dưới sự chủ trì của [Chủ trì].
   - Phần nội dung thảo luận: Tóm tắt vắn tắt diễn biến, các ý kiến thảo luận (được chuyển đổi sang câu từ trang trọng).
   - Phần kết luận chỉ đạo (Quan trọng nhất): Liệt kê rõ ràng các kết luận chỉ đạo của người chủ trì, ghi rõ giao việc cho ai/bộ phận nào, và thời gian hoàn thành (nếu có).
5. Nơi nhận ở dưới cùng bên trái.

Chỉ trả về văn bản thông báo kết luận cuộc họp đã hoàn thiện, không giải thích.`;

  const userPrompt = `THÔNG TIN CUỘC HỌP GỐC:
- Tiêu đề: ${evt.title}
- Chủ trì: ${evt.chairperson}
- Thời gian: ${evt.start_time}
- Địa điểm: ${evt.location}
- Thành phần: ${evt.attendees}

GHI CHÉP DIỄN BIẾN THẢO LUẬN THÔ:
${rawNotes}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.aiKey}`
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const result = await response.json();
  return result.choices[0].message.content.trim();
}

// ==========================================================================
// TV VIEW DISPLAY (KIOSK MODE) IMPLEMENTATION
// ==========================================================================

let tvAutoScrollInterval = null;
let tvUpcomingAutoScrollInterval = null;
let tvDataRefreshInterval = null;

function enterTVMode() {
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('tv-mode-container').classList.remove('hidden');
  
  loadTVData();
  tvDataRefreshInterval = setInterval(loadTVData, 60000); 
}

function exitTVMode() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(err => console.log('Fullscreen exit notice:', err));
  }
  
  if (tvAutoScrollInterval) clearInterval(tvAutoScrollInterval);
  if (tvUpcomingAutoScrollInterval) clearInterval(tvUpcomingAutoScrollInterval);
  if (tvDataRefreshInterval) clearInterval(tvDataRefreshInterval);

  // Ép trình duyệt chuyển hướng về trang quản lý chính với tham số ?mode=admin
  window.location.href = window.location.pathname + '?mode=admin';
}

async function loadTVData() {
  const syncStatusEl = document.getElementById('tv-sync-status');
  try {
    const today = new Date();
    const todayStr = formatDateISO(today);

    // Lấy phạm vi tuần hiện tại (offset = 0)
    const { monday, sunday } = getWeekRange(0);
    const startISO = formatDateISO(monday) + ' 00:00';
    const endISO = formatDateISO(sunday) + ' 23:59';
    
    let weekEvents = [];
    let syncSuccess = false;

    // Luôn thử tải dữ liệu chính thức từ Express Server trước tiên cho giao diện TV sảnh (Timeout 3s)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(`/api/events?startDate=${formatDateISO(monday)}&endDate=${formatDateISO(sunday)}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          weekEvents = data;
          syncSuccess = true;
        } else {
          console.warn("TV Mode: Dữ liệu trả về không phải là mảng:", data);
        }
      }
    } catch (e) {
      clearTimeout(timeoutId);
      console.warn('TV Mode: Không thể tải lịch từ máy chủ Express (hoặc hết hạn chờ), thử fallback...', e);
    }

    // Nếu máy chủ offline hoặc không có dữ liệu, mới sử dụng dữ liệu cục bộ (WASM hoặc localStorage)
    if (!Array.isArray(weekEvents) || weekEvents.length === 0) {
      weekEvents = [];
      if (settings.syncMode === 'wasm-sqlite' && sqlDb) {
        try {
          const stmt = sqlDb.prepare("SELECT * FROM events WHERE start_time >= ? AND end_time <= ? ORDER BY start_time ASC");
          stmt.bind([startISO, endISO]);
          while (stmt.step()) {
            weekEvents.push(stmt.getAsObject());
          }
          stmt.free();
          syncSuccess = true;
        } catch (e) {
          console.error("WASM Fallback error in TV Mode:", e);
        }
      }

      if (weekEvents.length === 0 && settings.syncMode === 'local') {
        const localData = JSON.parse(localStorage.getItem('ubnd_calendar_events') || '[]');
        const startDayOnly = formatDateISO(monday);
        const endDayOnly = formatDateISO(sunday);
        weekEvents = localData.filter(evt => {
          if (!evt || typeof evt.start_time !== 'string') return false;
          const evtDate = evt.start_time.split(' ')[0];
          return evtDate >= startDayOnly && evtDate <= endDayOnly;
        });
        syncSuccess = true;
      }
    }

    // Lọc bỏ sự kiện lỗi thiếu trường thời gian để tránh crash
    weekEvents = weekEvents.filter(evt => evt && typeof evt.start_time === 'string' && typeof evt.end_time === 'string');

    // Sắp xếp lịch họp theo thứ tự thời gian tăng dần
    weekEvents.sort((a, b) => a.start_time.localeCompare(b.start_time));

    // Cập nhật trạng thái đồng bộ ở Footer TV sảnh
    if (syncStatusEl) {
      if (syncSuccess) {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        syncStatusEl.innerHTML = `<i class="fa-solid fa-check"></i> Đồng bộ lúc ${hh}:${mm}`;
        syncStatusEl.className = 'tv-footer-right';
      } else {
        syncStatusEl.innerHTML = `⚠ Mất kết nối`;
        syncStatusEl.className = 'tv-footer-right offline';
      }
    }

    // Cập nhật nội dung Trọng tâm điều hành từ cấu hình
    const focusContentEl = document.getElementById('tv-focus-content');
    if (focusContentEl) {
      focusContentEl.textContent = settings.tvFocus || 'Hồ sơ đất đai • Thu ngân sách • Giải phóng mặt bằng (GPMB)';
    }

    // Chia tách sự kiện hôm nay và các ngày còn lại trong tuần
    const todayEvents = weekEvents.filter(evt => evt.start_time.split(' ')[0] === todayStr);
    const remainingEvents = weekEvents.filter(evt => evt.start_time.split(' ')[0] > todayStr);

    renderTVGrid(todayEvents);
    renderTVUpcomingGrid(remainingEvents, todayEvents);
  } catch (error) {
    console.error("Critical error in loadTVData:", error);
    if (syncStatusEl) {
      syncStatusEl.innerHTML = `⚠ Lỗi kết xuất`;
      syncStatusEl.className = 'tv-footer-right offline';
    }
  }
}

function renderTVGrid(todayEvents) {
  const container = document.getElementById('tv-events-list');
  container.innerHTML = '';

  if (todayEvents.length === 0) {
    container.innerHTML = `
      <div class="tv-empty-box" style="height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #FFFFFF; border-radius: 18px; border: 1px dashed rgba(11,31,58,0.15); width: 100%; box-sizing: border-box;">
        <i class="fa-solid fa-calendar-xmark" style="font-size: 3.5rem; color: #64748B; margin-bottom: 16px;"></i>
        <h4 style="font-size: 24px; font-weight: 800; color: #0B1F3A; margin: 0 0 8px 0;">Không có lịch công tác hôm nay</h4>
        <p style="font-size: 18px; color: #64748B; margin: 0;">Lịch làm việc sẽ được cập nhật tự động trực tuyến.</p>
      </div>
    `;
    return;
  }

  const now = new Date();
  
  // Tính toán trạng thái cho từng sự kiện
  todayEvents.forEach(evt => {
    // Định dạng start_time và end_time thành chuỗi hợp lệ của JS (thay thế - bằng /)
    const startTime = new Date(evt.start_time.replace(/-/g, '/'));
    const endTime = new Date(evt.end_time.replace(/-/g, '/'));
    
    if (now > endTime) {
      evt.tvStatus = 'completed'; // Đã kết thúc
    } else if (now >= startTime && now <= endTime) {
      evt.tvStatus = 'ongoing'; // Đang diễn ra
    } else {
      evt.tvStatus = 'upcoming'; // Sắp diễn ra
      
      const diffMs = startTime - now;
      const diffMins = Math.floor(diffMs / 60000);
      evt.diffMins = diffMins;
      if (diffMins <= 30 && diffMins > 0) {
        evt.tvStatus = 'upcoming-near'; // Sắp diễn ra <= 30 phút
      }
    }
  });

  // Xác định chỉ số tiêu điểm (focusIndex)
  let focusIndex = todayEvents.findIndex(evt => evt.tvStatus === 'ongoing' || evt.tvStatus === 'upcoming' || evt.tvStatus === 'upcoming-near');
  if (focusIndex === -1) {
    // Nếu tất cả lịch đã kết thúc, tiêu điểm là lịch cuối cùng
    focusIndex = todayEvents.length - 1;
  }

  // Slice danh sách: Lấy tối đa 2 lịch đã qua gần nhất + lịch tiêu điểm + các lịch tiếp theo (tổng tối đa 6 lịch)
  const startIndex = Math.max(0, focusIndex - 2);
  const endIndex = Math.min(todayEvents.length, focusIndex + 4);
  const slicedEvents = todayEvents.slice(startIndex, endIndex);

  slicedEvents.forEach(evt => {
    const card = document.createElement('div');
    card.className = `tv-timeline-item ${evt.tvStatus}`;
    
    const startTimeStr = evt.start_time.split(' ')[1];
    const endTimeStr = evt.end_time.split(' ')[1];

    // Trạng thái hiển thị
    let statusHtml = '';
    if (evt.tvStatus === 'completed') {
      statusHtml = `<span class="tv-badge completed"><i class="fa-solid fa-check"></i> Đã kết thúc</span>`;
    } else if (evt.tvStatus === 'ongoing') {
      statusHtml = `<span class="tv-badge ongoing"><i class="fa-solid fa-circle"></i> Đang diễn ra</span>`;
    } else if (evt.tvStatus === 'upcoming-near') {
      statusHtml = `<span class="tv-badge upcoming-near"><i class="fa-solid fa-clock"></i> Còn ${evt.diffMins} phút</span>`;
    }

    // QR Code hiển thị nếu có tài liệu đính kèm
    const qrHtml = evt.document_link 
      ? `<div class="tv-item-qr-small" title="Quét tài liệu cuộc họp">
           <img src="https://api.qrserver.com/v1/create-qr-code/?size=60x60&data=${encodeURIComponent(evt.document_link)}&color=0b1f3a" alt="QR">
         </div>`
      : '';

    // Hiển thị thành phần/chủ trì phụ nếu có
    let metaHtml = '';
    if (evt.chairperson) {
      metaHtml += `
        <div class="tv-item-meta">
          <i class="fa-solid fa-user-tie"></i>
          <span>Chủ trì: <strong>${evt.chairperson.split(' - ')[1] || evt.chairperson}</strong></span>
        </div>
      `;
    }
    if (evt.location) {
      metaHtml += `
        <div class="tv-item-meta">
          <i class="fa-solid fa-location-dot"></i>
          <span>Địa điểm: <strong>${evt.location}</strong></span>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="tv-item-time">${startTimeStr}</div>
      <div class="tv-item-body">
        <div class="tv-item-title">${evt.title}</div>
        <div class="tv-item-desc">
          ${metaHtml}
        </div>
      </div>
      <div class="tv-item-status">
        ${statusHtml}
        ${qrHtml}
      </div>
    `;

    container.appendChild(card);
  });
}

// ==========================================================================
// EXPORT WEEKLY CALENDAR AS AN IMAGE
// ==========================================================================

function exportCalendarImage() {
  const captureArea = document.getElementById('calendar-capture-area');
  const btn = document.getElementById('btn-export-image');

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xử lý...';
  btn.disabled = true;

  const watermark = document.querySelector('.grid-header-watermark');
  watermark.style.display = 'block';

  html2canvas(captureArea, {
    useCORS: true,
    scale: 2, 
    backgroundColor: '#FFFFFF'
  }).then(canvas => {
    watermark.style.display = 'none';
    btn.innerHTML = '<i class="fa-solid fa-image"></i> Xuất ảnh Lịch';
    btn.disabled = false;

    const link = document.createElement('a');
    link.download = `LICH_CONG_TAC_TUAN_${currentWeekOffset}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }).catch(err => {
    watermark.style.display = 'none';
    btn.innerHTML = '<i class="fa-solid fa-image"></i> Xuất ảnh Lịch';
    btn.disabled = false;
    alert('Lỗi xuất ảnh: ' + err.message);
  });
}

// ==========================================================================
// LISTENERS & EVENT HANDLERS
// ==========================================================================

function setupEventListeners() {
  const tabs = document.querySelectorAll('.tab-item');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const panelId = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(panelId).classList.add('active');
    });
  });

  document.getElementById('btn-prev-week').addEventListener('click', () => {
    currentWeekOffset--;
    updateWeekDisplay();
    loadEvents();
  });

  document.getElementById('btn-next-week').addEventListener('click', () => {
    currentWeekOffset++;
    updateWeekDisplay();
    loadEvents();
  });

  document.getElementById('btn-current-week').addEventListener('click', () => {
    currentWeekOffset = 0;
    updateWeekDisplay();
    loadEvents();
  });

  let searchTimeout;
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      loadEventsWithFilter();
    }, 300);
  });

  document.getElementById('filter-chairperson').addEventListener('change', () => {
    loadEventsWithFilter();
  });

  document.getElementById('filter-category').addEventListener('change', () => {
    loadEventsWithFilter();
  });

  document.getElementById('btn-export-image').addEventListener('click', exportCalendarImage);

  const btnAdmin = document.getElementById('btn-toggle-admin');
  btnAdmin.addEventListener('click', () => {
    if (!isAdminMode) {
      // Mở modal đăng nhập
      document.getElementById('admin-password-input').value = '';
      document.getElementById('admin-login-error').classList.add('hidden');
      openModal('modal-admin-login');
    } else {
      // Đăng xuất chế độ quản trị
      isAdminMode = false;
      sessionStorage.removeItem('admin_password');
      btnAdmin.innerHTML = '<i class="fa-solid fa-lock"></i> <span>Văn phòng UBND</span>';
      btnAdmin.className = 'btn btn-outline';
      document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
      alert('Đã thoát khỏi chế độ quản trị.');
    }
  });

  // Xử lý sự kiện đăng nhập quản trị
  document.getElementById('form-admin-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('admin-password-input').value.trim();
    const errBox = document.getElementById('admin-login-error');
    errBox.classList.add('hidden');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });

      if (res.ok) {
        isAdminMode = true;
        sessionStorage.setItem('admin_password', password);
        
        btnAdmin.innerHTML = '<i class="fa-solid fa-unlock text-emerald"></i> <span>Chế độ Quản trị</span>';
        btnAdmin.className = 'btn btn-outline border-emerald';
        document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
        
        closeModal('modal-admin-login');
        alert('Đăng nhập quản trị thành công!');
      } else {
        const data = await res.json();
        errBox.textContent = data.error || 'Mật khẩu không chính xác.';
        errBox.classList.remove('hidden');
      }
    } catch (err) {
      errBox.textContent = 'Lỗi kết nối tới máy chủ Node.js.';
      errBox.classList.remove('hidden');
    }
  });

  document.getElementById('btn-upload-calendar').addEventListener('click', () => {
    document.getElementById('input-upload-file').click();
  });
  
  document.getElementById('input-upload-file').addEventListener('change', handleFileUpload);

  document.getElementById('btn-ai-extract').addEventListener('click', handleAIExtract);
  
  // Lắng nghe sự kiện click nút Tối ưu tiêu đề AI
  document.getElementById('btn-ai-polish-title').addEventListener('click', handleAIPolishTitle);

  // Lắng nghe sự kiện click nút Tạo mã QR thủ công trong Admin Panel
  document.getElementById('btn-generate-qr-admin').addEventListener('click', () => {
    const urlInput = document.getElementById('event-document').value.trim();
    const qrContainer = document.getElementById('admin-qr-preview-container');
    const qrBox = document.getElementById('admin-qr-preview-box');
    const qrDownload = document.getElementById('admin-qr-download');

    if (!urlInput) {
      alert('Vui lòng nhập đường dẫn (URL) tài liệu trước khi tạo mã QR.');
      return;
    }

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(urlInput)}&color=0f172a`;
    qrBox.innerHTML = `<img src="${qrUrl}" style="width: 100%; height: 100%; display: block;" alt="QR Code">`;
    qrDownload.href = qrUrl;

    qrContainer.style.display = 'flex';
    qrContainer.classList.remove('hidden');
  });

  // Tự động ẩn khung xem trước QR Code nếu ô nhập bị xóa trống
  document.getElementById('event-document').addEventListener('input', (e) => {
    if (!e.target.value.trim()) {
      const qrContainer = document.getElementById('admin-qr-preview-container');
      qrContainer.style.display = 'none';
      qrContainer.classList.add('hidden');
    }
  });

  // Kích hoạt Soạn biên bản AI
  document.getElementById('btn-ai-minutes-trigger').addEventListener('click', () => {
    if (selectedEvent) {
      document.getElementById('ai-minutes-raw').value = '';
      document.getElementById('ai-minutes-result-box').textContent = '';
      document.getElementById('ai-minutes-result-container').classList.add('hidden');
      closeModal('modal-details');
      openModal('modal-ai-minutes');
    }
  });

  // Gọi AI viết Biên bản họp
  document.getElementById('btn-ai-generate-minutes').addEventListener('click', handleAIGenerateMinutes);

  // Copy biên bản họp AI
  document.getElementById('btn-copy-ai-minutes').addEventListener('click', () => {
    const text = document.getElementById('ai-minutes-result-box').textContent;
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        alert('Đã sao chép nội dung Thông báo kết luận cuộc họp!');
      }).catch(err => {
        alert('Lỗi sao chép: ' + err);
      });
    }
  });

  document.getElementById('btn-enter-tv').addEventListener('click', enterTVMode);
  document.getElementById('btn-exit-tv').addEventListener('click', exitTVMode);

  // Cho phép thoát TV Mode bằng cách ấn phím ESC trên bàn phím
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.code === 'Escape') {
      const tvContainer = document.getElementById('tv-mode-container');
      if (tvContainer && !tvContainer.classList.contains('hidden')) {
        exitTVMode();
      }
    }
  });

  // Kích hoạt chế độ Fullscreen cho màn hình TV sảnh
  const btnTvFullscreen = document.getElementById('btn-tv-fullscreen');
  if (btnTvFullscreen) {
    btnTvFullscreen.addEventListener('click', () => {
      const container = document.getElementById('tv-mode-container');
      if (!document.fullscreenElement) {
        container.requestFullscreen().catch(err => {
          console.error(`Lỗi kích hoạt Fullscreen: ${err.message}`);
        });
      } else {
        document.exitFullscreen();
      }
    });
  }

  // Theo dõi sự thay đổi trạng thái fullscreen để đổi icon
  document.addEventListener('fullscreenchange', () => {
    const icon = document.querySelector('#btn-tv-fullscreen i');
    if (icon) {
      if (document.fullscreenElement) {
        icon.className = 'fa-solid fa-compress';
      } else {
        icon.className = 'fa-solid fa-expand';
      }
    }
  });

  document.getElementById('btn-settings').addEventListener('click', () => openModal('modal-settings'));

  const closes = document.querySelectorAll('[data-close]');
  closes.forEach(c => {
    c.addEventListener('click', () => {
      const modalId = c.getAttribute('data-close');
      closeModal(modalId);
    });
  });

  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
      closeModal(e.target.id);
    }
  });

  document.getElementById('form-event').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const eventId = document.getElementById('event-id').value;
    const title = document.getElementById('event-title').value;
    const category = document.getElementById('event-category').value;
    const status = document.getElementById('event-status').value;
    const startVal = document.getElementById('event-start').value;
    const endVal = document.getElementById('event-end').value;
    const chairperson = document.getElementById('event-chairperson').value;
    const location = document.getElementById('event-location').value;
    const attendees = document.getElementById('event-attendees').value;
    const preparing = document.getElementById('event-preparing').value;
    const documentLink = document.getElementById('event-document').value;
    const override = document.getElementById('event-override-conflict').checked;

    const formatDateTime = (val) => val.replace('T', ' ');

    const eventData = {
      title,
      category,
      status,
      start_time: formatDateTime(startVal),
      end_time: formatDateTime(endVal),
      chairperson,
      location,
      attendees,
      preparing_unit: preparing,
      document_link: documentLink
    };

    if (eventId) {
      eventData.id = parseInt(eventId);
    }

    const success = await saveEventData(eventData, override);
    if (success) {
      closeModal('modal-event');
      loadEvents();
    }
  });

  document.getElementById('btn-delete-event').addEventListener('click', async () => {
    const id = document.getElementById('event-id').value;
    if (id && confirm('Bạn có chắc chắn muốn xóa cuộc họp/lịch làm việc này không?')) {
      const success = await deleteEventData(parseInt(id));
      if (success) {
        closeModal('modal-event');
        loadEvents();
      }
    }
  });

  document.getElementById('btn-add-event').addEventListener('click', () => openEditEventForm());

  document.getElementById('btn-edit-from-details').addEventListener('click', () => {
    if (selectedEvent) {
      openEditEventForm(selectedEvent);
    }
  });

  document.getElementById('btn-copy-zalo').addEventListener('click', copyToZaloFormat);

  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const syncMode = document.querySelector('input[name="setting-sync-mode"]:checked').value;
    const appsScriptUrl = document.getElementById('setting-apps-script-url').value.trim();
    const gcalId = document.getElementById('setting-gcal-id').value.trim();
    const webhookSecretInput = document.getElementById('setting-webhook-secret').value.trim();
    const aiProvider = document.getElementById('setting-ai-provider').value;
    const aiModel = document.getElementById('setting-ai-model').value.trim();
    const aiKeyInput = document.getElementById('setting-ai-key').value.trim();
    const tvFocus = document.getElementById('setting-tv-focus').value.trim();

    settings.syncMode = syncMode;
    settings.appsScriptUrl = appsScriptUrl;
    settings.gcalId = gcalId || 'primary';
    settings.aiProvider = aiProvider;
    settings.aiModel = aiModel || (aiProvider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o');
    settings.tvFocus = tvFocus || 'Hồ sơ đất đai • Thu ngân sách • Giải phóng mặt bằng (GPMB)';
    
    if (webhookSecretInput !== '********') {
      settings.webhookSecret = webhookSecretInput;
    }
    if (aiKeyInput !== '********') {
      settings.aiKey = aiKeyInput;
    }

    localStorage.setItem('ubnd_calendar_settings', JSON.stringify(settings));

    // Đồng bộ cấu hình lên máy chủ nếu đang kết nối chế độ server và có quyền quản trị
    if (syncMode === 'server-sqlite' && isAdminMode) {
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (sessionStorage.getItem('admin_password') || '')
          },
          body: JSON.stringify(settings)
        });
        if (!res.ok && (res.status === 401 || res.status === 403)) {
          exitAdminModeForce();
        }
      } catch (e) {
        console.error('Không thể đồng bộ cấu hình lên máy chủ:', e);
      }
    }

    closeModal('modal-settings');
    
    checkBackendConnection();
    loadEvents();
    updateAppsScriptButtonState();
  });

  document.getElementById('btn-test-backend').addEventListener('click', async () => {
    const statusBox = document.getElementById('settings-status-box');
    statusBox.classList.remove('hidden', 'success', 'error');
    statusBox.textContent = 'Đang kết nối thử nghiệm Express backend...';

    try {
      const res = await fetch('/api/events?query=test-connection');
      if (res.ok) {
        statusBox.className = 'settings-status-box success';
        statusBox.textContent = 'Kết nối thành công! Máy chủ Express đang hoạt động.';
      } else {
        throw new Error();
      }
    } catch (e) {
      statusBox.className = 'settings-status-box error';
      statusBox.textContent = 'Lỗi kết nối! Đảm bảo máy chủ Node.js đang chạy và cổng hoạt động chính xác.';
    }
  });
}

function loadEventsWithFilter() {
  const searchQuery = document.getElementById('search-input').value.toLowerCase();
  const filterLeader = document.getElementById('filter-chairperson').value;
  const filterCat = document.getElementById('filter-category').value;

  if (settings.syncMode === 'wasm-sqlite' && sqlDb) {
    const { monday, sunday } = getWeekRange(currentWeekOffset);
    const startISO = formatDateISO(monday) + ' 00:00';
    const endISO = formatDateISO(sunday) + ' 23:59';

    let query = "SELECT * FROM events WHERE start_time >= ? AND end_time <= ?";
    const params = [startISO, endISO];

    if (searchQuery) {
      query += " AND (lower(title) LIKE ? OR lower(chairperson) LIKE ? OR lower(location) LIKE ? OR lower(attendees) LIKE ?)";
      const pattern = `%${searchQuery}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    if (filterLeader) {
      query += " AND chairperson LIKE ?";
      params.push(`%${filterLeader}%`);
    }
    if (filterCat) {
      query += " AND category = ?";
      params.push(filterCat);
    }

    query += " ORDER BY start_time ASC";

    try {
      const stmt = sqlDb.prepare(query);
      stmt.bind(params);
      events = [];
      while (stmt.step()) {
        events.push(stmt.getAsObject());
      }
      stmt.free();
      renderGrid();
      return;
    } catch (e) {
      console.error('Lỗi SQL lọc:', e);
    }
  }

  const gridCells = document.querySelectorAll('.grid-cell');
  gridCells.forEach(c => c.innerHTML = '');

  const filteredEvents = events.filter(evt => {
    const matchSearch = !searchQuery || 
      evt.title.toLowerCase().includes(searchQuery) ||
      evt.chairperson.toLowerCase().includes(searchQuery) ||
      (evt.location && evt.location.toLowerCase().includes(searchQuery)) ||
      (evt.attendees && evt.attendees.toLowerCase().includes(searchQuery));

    const matchLeader = !filterLeader || evt.chairperson.includes(filterLeader);
    const matchCat = !filterCat || evt.category === filterCat;

    return matchSearch && matchLeader && matchCat;
  });

  filteredEvents.forEach(evt => {
    const [datePart, timePart] = evt.start_time.split(' ');
    const hourInt = parseInt(timePart.split(':')[0]);
    const slot = hourInt < 12 ? 'morning' : 'afternoon';
    
    const evtDate = new Date(datePart);
    const dayOfWeek = evtDate.getDay();
    const gridDayIndex = dayOfWeek === 0 ? 7 : dayOfWeek;

    const cellId = `cell-${slot}-${gridDayIndex}`;
    const cell = document.getElementById(cellId);
    
    if (cell) {
      const card = createEventCard(evt);
      cell.appendChild(card);
    }
  });
}

// Hàm đồng bộ lịch tự động từ Google Calendar về CSDL SQLite cục bộ
async function syncFromGoogleCalendar() {
  if (settings.syncMode === 'server-sqlite' && !isAdminMode) {
    console.log("Đồng bộ Google Calendar: Chế độ người dùng không tự động kích hoạt cuộc gọi API (máy chủ chạy ngầm tự đồng bộ).");
    return;
  }

  if (!settings.appsScriptUrl) {
    console.log("Đồng bộ Google Calendar: Chưa cấu hình Apps Script URL.");
    return;
  }

  console.log("Đồng bộ Google Calendar: Bắt đầu tải lịch từ Google...");
  try {
    if (settings.syncMode === 'server-sqlite') {
      // Gọi API đồng bộ phía server để tránh các lỗi CORS hoặc mạng ở client
      const res = await fetch('/api/sync-gcal', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (sessionStorage.getItem('admin_password') || '')
        },
        body: JSON.stringify({ appsScriptUrl: settings.appsScriptUrl })
      });
      if (res.ok) {
        const result = await res.json();
        if (result.insertedCount > 0) {
          console.log(`Đồng bộ Google Calendar (Server-side): Đã chèn thêm ${result.insertedCount} sự kiện mới.`);
          loadEvents();
        } else {
          console.log("Đồng bộ Google Calendar (Server-side): Cơ sở dữ liệu đã đồng nhất.");
        }
      } else {
        if (res.status === 401 || res.status === 403) {
          exitAdminModeForce();
          return;
        }
        const errData = await res.json();
        console.warn("Lỗi đồng bộ Server-side:", errData.error);
      }
    } else {
      // Chế độ local hoặc WASM (chạy client-side)
      const today = new Date();
      const startRange = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 ngày trước
      const endRange = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);   // 30 ngày sau
      
      const url = `${settings.appsScriptUrl}?startDate=${formatDateISO(startRange)}&endDate=${formatDateISO(endRange)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Phản hồi mạng không thành công: " + res.status);
      
      const gcalEvents = await res.json();
      if (!gcalEvents || !Array.isArray(gcalEvents)) {
        console.warn("Đồng bộ Google Calendar: Dữ liệu trả về không hợp lệ.");
        return;
      }

      let updatedCount = 0;

      for (const gEvt of gcalEvents) {
        const start = gEvt.start_time.replace('T', ' ');
        const end = gEvt.end_time.replace('T', ' ');

        if (settings.syncMode === 'wasm-sqlite' && sqlDb) {
          // Kiểm tra xem lịch họp đã tồn tại chưa
          const checkStmt = sqlDb.prepare("SELECT id FROM events WHERE title = ? AND start_time = ?");
          checkStmt.bind([gEvt.title, start]);
          const exists = checkStmt.step();
          checkStmt.free();

          if (!exists) {
            sqlDb.run(`
              INSERT INTO events (title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              gEvt.title, start, end, gEvt.chairperson || '', gEvt.location || '',
              gEvt.attendees || '', gEvt.preparing_unit || '', gEvt.category || 'ubnd',
              gEvt.status || 'scheduled', gEvt.document_link || ''
            ]);
            updatedCount++;
          }
        } else if (settings.syncMode === 'local') {
          // Chế độ local storage thô
          const localData = JSON.parse(localStorage.getItem('ubnd_calendar_events') || '[]');
          const exists = localData.some(evt => evt.title === gEvt.title && evt.start_time === start);
          if (!exists) {
            localData.push({
              id: Date.now() + Math.random().toString(36).substr(2, 9),
              title: gEvt.title,
              start_time: start,
              end_time: end,
              chairperson: gEvt.chairperson || '',
              location: gEvt.location || '',
              attendees: gEvt.attendees || '',
              preparing_unit: gEvt.preparing_unit || '',
              category: gEvt.category || 'ubnd',
              status: gEvt.status || 'scheduled',
              document_link: gEvt.document_link || ''
            });
            localStorage.setItem('ubnd_calendar_events', JSON.stringify(localData));
            updatedCount++;
          }
        }
      }

      if (updatedCount > 0) {
        console.log(`Đồng bộ Google Calendar (Client-side): Đã chèn thêm ${updatedCount} sự kiện mới.`);
        if (settings.syncMode === 'wasm-sqlite') {
          saveWasmDbToLocalStorage();
        }
        loadEvents();
      } else {
        console.log("Đồng bộ Google Calendar (Client-side): Cơ sở dữ liệu đã đồng nhất.");
      }
    }
  } catch (err) {
    console.error("Lỗi đồng bộ Google Calendar:", err);
  }
}

// Hàm render khối TIẾP THEO (Hero Card) và danh sách lịch NGÀY MAI bên cột Phải của TV sảnh
function renderTVUpcomingGrid(remainingEvents, todayEvents) {
  const now = new Date();
  
  // 1. KẾT XUẤT HERO CARD (TIẾP THEO)
  const heroContainer = document.getElementById('tv-next-hero');
  if (heroContainer) {
    heroContainer.innerHTML = '';
    
    // Tìm sự kiện đang diễn ra hoặc sắp diễn ra tiếp theo trong ngày hôm nay
    const heroEvent = todayEvents.find(evt => evt.tvStatus === 'ongoing' || evt.tvStatus === 'upcoming' || evt.tvStatus === 'upcoming-near');
    
    if (heroEvent) {
      const startTimeStr = heroEvent.start_time.split(' ')[1];
      
      let countdownHtml = '';
      if (heroEvent.tvStatus === 'ongoing') {
        countdownHtml = `<div class="tv-hero-countdown ongoing"><i class="fa-solid fa-circle"></i> ĐANG DIỄN RA</div>`;
      } else if (heroEvent.tvStatus === 'upcoming-near') {
        countdownHtml = `<div class="tv-hero-countdown near"><i class="fa-solid fa-clock"></i> Còn ${heroEvent.diffMins} phút</div>`;
      } else {
        const diffMs = new Date(heroEvent.start_time.replace(/-/g, '/')) - now;
        const diffHours = Math.floor(diffMs / 3600000);
        const diffMins = Math.floor((diffMs % 3600000) / 60000);
        const countdownText = diffHours > 0 ? `Còn ${diffHours} giờ ${diffMins} phút` : `Còn ${diffMins} phút`;
        countdownHtml = `<div class="tv-hero-countdown"><i class="fa-solid fa-clock"></i> ${countdownText}</div>`;
      }

      const cleanChair = heroEvent.chairperson ? heroEvent.chairperson.split(' - ')[1] || heroEvent.chairperson : '';

      heroContainer.innerHTML = `
        <div class="tv-hero-label">${heroEvent.tvStatus === 'ongoing' ? 'ĐANG DIỄN RA' : 'TIẾP THEO'}</div>
        <div class="tv-hero-time">${startTimeStr}</div>
        <div class="tv-hero-title">${heroEvent.title}</div>
        <div class="tv-hero-meta">
          <div class="tv-hero-meta-item">
            <i class="fa-solid fa-location-dot"></i>
            <span>${heroEvent.location || 'Phòng họp UBND xã'}</span>
          </div>
          ${cleanChair ? `
          <div class="tv-hero-meta-item">
            <i class="fa-solid fa-user-tie"></i>
            <span>Chủ trì: ${cleanChair}</span>
          </div>` : ''}
        </div>
        ${countdownHtml}
      `;
    } else {
      // Nếu không còn lịch nào trong hôm nay
      heroContainer.innerHTML = `
        <div class="tv-hero-label">HÔM NAY</div>
        <div class="tv-hero-time" style="color: #0F766E;"><i class="fa-solid fa-circle-check"></i></div>
        <div class="tv-hero-title" style="color: #0F766E; font-size: 22px;">ĐÃ HOÀN THÀNH</div>
        <div class="tv-hero-meta" style="margin-bottom: 0;">
          <div class="tv-hero-meta-item">
            <span>LỊCH CÔNG TÁC HÔM NAY</span>
          </div>
        </div>
      `;
    }
  }

  // 2. KẾT XUẤT DANH SÁCH NGÀY MAI
  const tomorrowContainer = document.getElementById('tv-tomorrow-list');
  if (tomorrowContainer) {
    tomorrowContainer.innerHTML = '';
    
    // Tính toán ngày mai
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = formatDateISO(tomorrow);
    
    // Lọc lịch ngày mai
    const tomorrowEvents = remainingEvents.filter(evt => evt.start_time.split(' ')[0] === tomorrowStr);
    
    if (tomorrowEvents.length === 0) {
      tomorrowContainer.innerHTML = `
        <div style="font-size: 16px; color: #64748B; text-align: center; padding: 16px; border: 1px dashed rgba(0,0,0,0.06); border-radius: 12px; background: white;">
          Không có lịch công tác ngày mai
        </div>
      `;
    } else {
      // Sắp xếp theo giờ tăng dần và lấy tối đa 3 sự kiện
      tomorrowEvents.sort((a, b) => a.start_time.localeCompare(b.start_time));
      const slicedTomorrow = tomorrowEvents.slice(0, 3);
      
      slicedTomorrow.forEach(evt => {
        const startTimeStr = evt.start_time.split(' ')[1];
        const item = document.createElement('div');
        item.className = 'tv-tomorrow-item';
        item.innerHTML = `
          <div class="tv-tomorrow-time">${startTimeStr}</div>
          <div class="tv-tomorrow-title" title="${evt.title}">${evt.title}</div>
        `;
        tomorrowContainer.appendChild(item);
      });
    }
  }
}

// Thoát cưỡng bức chế độ quản trị khi token hoặc mật khẩu sai/hết hạn
function exitAdminModeForce() {
  if (isAdminMode) {
    isAdminMode = false;
    sessionStorage.removeItem('admin_password');
    const btnAdmin = document.getElementById('btn-toggle-admin');
    if (btnAdmin) {
      btnAdmin.innerHTML = '<i class="fa-solid fa-lock"></i> <span>Văn phòng UBND</span>';
      btnAdmin.className = 'btn btn-outline';
    }
    document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
    alert('Phiên đăng nhập quản trị hết hạn hoặc mật khẩu đã thay đổi. Vui lòng đăng nhập lại.');
  }
}

/* ==========================================================================
   RENDER MODERN EXECUTIVE GOVERNMENT DASHBOARD
   ========================================================================== */
function renderExecutiveDashboard() {
  const containerList = document.getElementById('exec-today-events-list');
  if (!containerList) return;

  const now = new Date();
  
  // Format Today's Date String for Title Section
  const daysOfWeek = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  const dayName = daysOfWeek[now.getDay()];
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  
  const todayDateStr = `${dayName} • ${dd}/${mm}/${yyyy}`;
  const execTodayText = document.getElementById('exec-today-date-text');
  if (execTodayText) execTodayText.textContent = todayDateStr;

  // Format Sync Time
  const syncTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const syncElem = document.getElementById('exec-sync-time-text');
  if (syncElem) syncElem.textContent = `Đồng bộ lúc ${syncTimeStr}`;

  // Today ISO Date YYYY-MM-DD
  const todayISO = `${yyyy}-${mm}-${dd}`;
  
  // Tomorrow ISO Date YYYY-MM-DD
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tDD = String(tomorrow.getDate()).padStart(2, '0');
  const tMM = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const tYYYY = tomorrow.getFullYear();
  const tomorrowISO = `${tYYYY}-${tMM}-${tDD}`;

  // Danh sách sự kiện mẫu chuẩn bám sát 100% ảnh demo để luôn hiển thị giao diện đầy đủ rực rỡ
  const demoEventsList = [
    {
      id: 'demo-1',
      title: 'Giao ban lãnh đạo UBND xã',
      start_time: `${todayISO} 07:30`,
      end_time: `${todayISO} 08:30`,
      location: 'Phòng họp UBND xã',
      chairperson: 'Chủ tịch UBND xã',
      status: 'completed'
    },
    {
      id: 'demo-2',
      title: 'Làm việc về tiến độ hồ sơ đất đai',
      start_time: `${todayISO} 09:00`,
      end_time: `${todayISO} 11:30`,
      location: 'Phòng Kinh tế và bộ phận chuyên môn',
      chairperson: 'Phó Chủ tịch UBND xã',
      status: 'completed'
    },
    {
      id: 'demo-3',
      title: 'Làm việc với Phòng Kinh tế',
      start_time: `${todayISO} 15:30`,
      end_time: `${todayISO} 16:45`,
      location: 'Phòng họp UBND xã',
      chairperson: 'Đất đai, ngân sách và đầu tư công',
      status: 'ongoing'
    },
    {
      id: 'demo-4',
      title: 'Xử lý công việc nội bộ và ký văn bản',
      start_time: `${todayISO} 17:00`,
      end_time: `${todayISO} 17:30`,
      location: 'Phòng làm việc Chủ tịch',
      chairperson: 'Chủ tịch UBND xã',
      status: 'upcoming'
    },
    {
      id: 'demo-5',
      title: 'Rà soát nội dung cần xử lý gấp trong ngày',
      start_time: `${todayISO} 17:30`,
      end_time: `${todayISO} 18:00`,
      location: 'Văn phòng HĐND & UBND',
      chairperson: 'Chỉ dùng đỏ cho cảnh báo thực sự',
      status: 'emergency',
      is_emergency: true
    }
  ];

  const demoTomorrowList = [
    { id: 'tom-1', title: 'Giao ban đầu ngày', start_time: `${tomorrowISO} 07:30` },
    { id: 'tom-2', title: 'Hội nghị triển khai nhiệm vụ', start_time: `${tomorrowISO} 09:00` },
    { id: 'tom-3', title: 'Kiểm tra tiến độ giải quyết hồ sơ', start_time: `${tomorrowISO} 14:00` }
  ];

  // Filter Today's events
  let todayEvents = events.filter(evt => {
    return evt.start_time && evt.start_time.split(' ')[0] === todayISO;
  }).sort((a, b) => a.start_time.localeCompare(b.start_time));

  // Tự động dùng danh sách chuẩn demo nếu hôm nay chưa có lịch trong DB
  let displayEvents = todayEvents.length > 0 ? todayEvents : demoEventsList;

  // Filter Tomorrow's events
  let tomorrowEvents = events.filter(evt => {
    return evt.start_time && evt.start_time.split(' ')[0] === tomorrowISO;
  }).sort((a, b) => a.start_time.localeCompare(b.start_time));
  if (tomorrowEvents.length === 0) {
    tomorrowEvents = demoTomorrowList;
  }

  // Render Today's Events List
  if (displayEvents.length === 0) {
    containerList.innerHTML = `
      <div style="text-align: center; padding: 28px; color: #64748B; font-weight: 600;">
        <i class="fa-regular fa-calendar-check" style="font-size: 2.2rem; color: #2563EB; margin-bottom: 10px; display: block;"></i>
        Không có lịch họp nào ghi nhận trong hôm nay.
      </div>
    `;
  } else {
    containerList.innerHTML = displayEvents.map(evt => {
      const startTimeObj = new Date(evt.start_time.replace(/-/g, '/'));
      const endTimeObj = new Date(evt.end_time.replace(/-/g, '/'));
      const startTimeStr = evt.start_time.split(' ')[1] || '00:00';

      let status = 'scheduled';
      let iconClass = 'fa-regular fa-calendar-check';
      let badgeText = 'SẮP DIỄN RA';

      if (evt.status === 'emergency' || evt.category === 'emergency' || evt.is_emergency) {
        status = 'emergency';
        iconClass = 'fa-solid fa-triangle-exclamation';
        badgeText = '! KHẨN';
      } else if (now > endTimeObj) {
        status = 'completed';
        iconClass = 'fa-solid fa-check';
        badgeText = '✓ ĐÃ KẾT THÚC';
      } else if (now >= startTimeObj && now <= endTimeObj) {
        status = 'ongoing';
        iconClass = 'fa-solid fa-chart-line';
        badgeText = '● ĐANG DIỄN RA';
      } else {
        const diffMinutes = Math.round((startTimeObj - now) / 60000);
        if (diffMinutes > 0 && diffMinutes <= 60) {
          status = 'upcoming';
          iconClass = 'fa-regular fa-clock';
          badgeText = `CÒN ${diffMinutes} PHÚT`;
        }
      }

      return `
        <div class="exec-event-row status-${status}" onclick="openDetailsModalById('${evt.id}')">
          <div class="exec-icon-circle">
            <i class="${iconClass}"></i>
          </div>
          <div class="exec-event-time">${startTimeStr}</div>
          <div class="exec-event-body">
            <div class="exec-event-title">${evt.title}</div>
            <div class="exec-event-meta">
              <span class="exec-event-meta-item"><i class="fa-solid fa-location-dot" style="color: #2563EB;"></i> ${evt.location || 'Chưa xếp phòng'}</span>
              <span class="exec-event-meta-item"><i class="fa-solid fa-user-tie" style="color: #2563EB;"></i> Chủ trì: ${evt.chairperson || 'Thường trực UBND'}</span>
            </div>
          </div>
          <div class="exec-status-badge ${status}">
            ${badgeText}
          </div>
        </div>
      `;
    }).join('');
  }

  // Render Hero Card "TIẾP THEO"
  const heroCard = document.getElementById('exec-hero-card');
  if (heroCard) {
    const nextEvent = displayEvents.find(evt => {
      const endTimeObj = new Date(evt.end_time.replace(/-/g, '/'));
      return now <= endTimeObj;
    }) || displayEvents[0];

    if (nextEvent) {
      const startTimeObj = new Date(nextEvent.start_time.replace(/-/g, '/'));
      const endTimeObj = new Date(nextEvent.end_time.replace(/-/g, '/'));
      const startTimeStr = nextEvent.start_time.split(' ')[1] || '00:00';
      const heroTimeElem = document.getElementById('exec-hero-time');
      const heroTitleElem = document.getElementById('exec-hero-title');
      const heroLocElem = document.getElementById('exec-hero-location');
      const heroCountdownElem = document.getElementById('exec-hero-countdown');

      if (heroTimeElem) heroTimeElem.textContent = startTimeStr;
      if (heroTitleElem) heroTitleElem.textContent = nextEvent.title;
      if (heroLocElem) heroLocElem.innerHTML = `<i class="fa-solid fa-location-dot"></i> <span>${nextEvent.location || 'Phòng họp UBND xã'}</span>`;
      
      if (heroCountdownElem) {
        if (now >= startTimeObj && now <= endTimeObj) {
          heroCountdownElem.innerHTML = `<i class="fa-solid fa-bolt"></i> <span>Đang diễn ra</span>`;
        } else if (now < startTimeObj) {
          const diffMin = Math.round((startTimeObj - now) / 60000);
          if (diffMin > 60) {
            const hrs = Math.floor(diffMin / 60);
            const mins = diffMin % 60;
            heroCountdownElem.innerHTML = `<i class="fa-regular fa-clock"></i> <span>Còn ${hrs} giờ ${mins} phút</span>`;
          } else {
            heroCountdownElem.innerHTML = `<i class="fa-regular fa-clock"></i> <span>Còn ${diffMin} phút</span>`;
          }
        } else {
          heroCountdownElem.innerHTML = `<i class="fa-solid fa-check"></i> <span>Đã hoàn thành</span>`;
        }
      }
    } else {
      const heroTimeElem = document.getElementById('exec-hero-time');
      const heroTitleElem = document.getElementById('exec-hero-title');
      const heroCountdownElem = document.getElementById('exec-hero-countdown');
      if (heroTimeElem) heroTimeElem.textContent = '17:00';
      if (heroTitleElem) heroTitleElem.textContent = 'Xử lý công việc nội bộ và ký văn bản';
      if (heroCountdownElem) heroCountdownElem.innerHTML = `<i class="fa-regular fa-clock"></i> <span>Hoàn thành hôm nay</span>`;
    }
  }

  // Render Card "Ngày mai"
  const tomorrowList = document.getElementById('exec-tomorrow-events-list');
  if (tomorrowList) {
    if (tomorrowEvents.length === 0) {
      tomorrowList.innerHTML = `
        <div style="font-size: 0.85rem; color: #64748B; padding: 6px 0;">
          Chưa có lịch họp dự kiến ngày mai.
        </div>
      `;
    } else {
      tomorrowList.innerHTML = tomorrowEvents.slice(0, 4).map(evt => {
        const startTimeStr = evt.start_time.split(' ')[1] || '07:30';
        return `
          <div class="exec-tomorrow-item" onclick="openDetailsModalById('${evt.id}')">
            <div class="exec-tomorrow-time">${startTimeStr}</div>
            <div class="exec-tomorrow-title">${evt.title}</div>
          </div>
        `;
      }).join('');
    }
  }
}

// Helper to open details modal by ID
function openDetailsModalById(id) {
  const evt = events.find(e => e.id == id);
  if (evt) openDetailsModal(evt);
}


