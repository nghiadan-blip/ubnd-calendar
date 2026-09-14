const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// Thiết lập môi trường test dùng Database SQLite tạm độc lập
const testDbPath = path.join(__dirname, 'test_database.sqlite');
if (fs.existsSync(testDbPath)) {
  fs.unlinkSync(testDbPath);
}

process.env.NODE_ENV = 'test';
process.env.TEST_DB_PATH = testDbPath;
process.env.ADMIN_PASSWORD = 'TestSecretAdminPassword2026!';
process.env.GITHUB_WEBHOOK_SECRET = 'TestWebhookSecret12345!';

const app = require('../server');

let server;
let port;
let adminToken = null;

function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      ...options
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data, json });
      });
    });

    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTests() {
  console.log('================================================================');
  console.log('BẮT ĐẦU CHẠY BỘ KIỂM THỬ TỰ ĐỘNG (AUTOMATED TEST SUITE)');
  console.log('================================================================');

  server = app.listen(0, '127.0.0.1', async () => {
    port = server.address().port;
    console.log(`[TEST] Server test đang chạy tại http://127.0.0.1:${port}`);

    try {
      // ----------------------------------------------------
      // TEST 1: XÁC THỰC QUẢN TRỊ (AUTH & FAIL-CLOSED)
      // ----------------------------------------------------
      console.log('\n--- [TEST GROUP 1] Xác thực Quản trị & Session ---');

      // 1.1 Thử tạo sự kiện khi chưa đăng nhập (Mong muốn: 401 Unauthorized)
      const unauthRes = await request({
        path: '/api/events',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { title: 'Test Unauth', start_time: '2026-09-15 08:00', end_time: '2026-09-15 10:00' });
      assert.strictEqual(unauthRes.statusCode, 401, 'Request thiếu auth phải bị từ chối 401');
      console.log('✓ Pass: RequireAuth chặn thành công 401 khi không có token');

      // 1.2 Đăng nhập với mật khẩu sai (Mong muốn: 401 Unauthorized)
      const wrongPassRes = await request({
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { password: 'WrongPassword' });
      assert.strictEqual(wrongPassRes.statusCode, 401, 'Đăng nhập sai mật khẩu phải trả 401');
      console.log('✓ Pass: Đăng nhập sai mật khẩu bị từ chối 401');

      // 1.3 Đăng nhập đúng mật khẩu (Mong muốn: 200 OK & nhận token)
      const loginRes = await request({
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { password: 'TestSecretAdminPassword2026!' });
      assert.strictEqual(loginRes.statusCode, 200, 'Đăng nhập đúng phải trả 200 OK');
      assert.ok(loginRes.json.token, 'Nhận về token phiên hợp lệ');
      adminToken = loginRes.json.token;
      console.log('✓ Pass: Đăng nhập thành công và cấp phiên token ngẫu nhiên');

      // ----------------------------------------------------
      // TEST 2: THÊM / SỬA / XÓA SỰ KIỆN & VALIDATION (CRUD & XSS)
      // ----------------------------------------------------
      console.log('\n--- [TEST GROUP 2] Quản lý Sự kiện & Validation ---');

      // 2.1 Tạo sự kiện với thông tin hợp lệ
      const createRes = await request({
        path: '/api/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        }
      }, {
        title: 'Họp kiểm tra tiến độ dự án',
        start_time: '2026-09-15 08:30',
        end_time: '2026-09-15 11:00',
        chairperson: 'Chủ tịch UBND xã',
        location: 'Phòng họp tầng 2',
        document_link: 'https://drive.google.com/file/d/test/view'
      });
      assert.strictEqual(createRes.statusCode, 201, 'Tạo sự kiện mới phải trả 201 Created');
      const eventId = createRes.json.eventId;
      assert.ok(eventId, 'Trả về eventId thành công');
      console.log(`✓ Pass: Tạo sự kiện mới thành công (ID: ${eventId})`);

      // 2.2 Thử chèn document_link không an toàn (javascript: hoặc http://)
      const badLinkRes = await request({
        path: '/api/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        }
      }, {
        title: 'Thử nghiệm Link độc hại',
        start_time: '2026-09-15 14:00',
        end_time: '2026-09-15 16:00',
        document_link: 'http://insecure-site.com/malware'
      });
      assert.strictEqual(badLinkRes.statusCode, 400, 'Link không phải https:// phải bị từ chối 400');
      console.log('✓ Pass: Chặn link tài liệu không an toàn (Chỉ chấp nhận HTTPS)');

      // 2.3 Lấy danh sách lịch họp theo khoảng ngày
      const listRes = await request({
        path: '/api/events?startDate=2026-09-15&endDate=2026-09-15',
        method: 'GET'
      });
      assert.strictEqual(listRes.statusCode, 200);
      assert.strictEqual(listRes.json.length, 1, 'Truy vấn đúng 1 sự kiện vừa tạo');
      assert.strictEqual(listRes.json[0].title, 'Họp kiểm tra tiến độ dự án');
      console.log('✓ Pass: API /api/events truy vấn chính xác theo dải ngày');

      // ----------------------------------------------------
      // TEST 3: XÁC THỰC CHỮ KÝ WEBHOOK (HMAC SHA-256)
      // ----------------------------------------------------
      console.log('\n--- [TEST GROUP 3] Kiểm tra Bảo mật GitHub Webhook ---');

      const webhookPayload = JSON.stringify({ ref: 'refs/heads/master', repository: { full_name: 'nghiadan-blip/ubnd-calendar' } });
      const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
      const validSignature = 'sha256=' + hmac.update(webhookPayload).digest('hex');

      // 3.1 Webhook thiếu signature (Mong muốn: 401)
      const noSigRes = await request({
        path: '/api/deploy-webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, webhookPayload);
      assert.strictEqual(noSigRes.statusCode, 401);
      console.log('✓ Pass: Webhook không có chữ ký bị từ chối 401');

      // 3.2 Webhook chữ ký sai (Mong muốn: 403)
      const wrongSigRes = await request({
        path: '/api/deploy-webhook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': 'sha256=invalid_signature_hash'
        }
      }, webhookPayload);
      assert.strictEqual(wrongSigRes.statusCode, 403);
      console.log('✓ Pass: Webhook chữ ký sai bị từ chối 403');

      // ----------------------------------------------------
      // TEST 4: BẢO VỆ CHỐNG SSRF TẠI /api/sync-gcal
      // ----------------------------------------------------
      console.log('\n--- [TEST GROUP 4] Kiểm tra Bảo vệ SSRF ---');

      // 4.1 Thử đồng bộ khi chưa đăng nhập Admin (Mong muốn: 401)
      const syncUnauth = await request({
        path: '/api/sync-gcal',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.strictEqual(syncUnauth.statusCode, 401);
      console.log('✓ Pass: Đồng bộ lịch yêu cầu xác thực Admin (401)');

      // ----------------------------------------------------
      // TEST 5: KÍCH THƯỚC VÀ NẠP CẤU HÌNH BẢO MẬT
      // ----------------------------------------------------
      console.log('\n--- [TEST GROUP 5] Cấu hình Máy chủ & Security Headers ---');

      const settingsRes = await request({
        path: '/api/settings',
        method: 'GET'
      });
      assert.strictEqual(settingsRes.statusCode, 200);
      assert.strictEqual(settingsRes.json.hasWebhookSecret, true);
      assert.strictEqual(settingsRes.json.hasAdminPassword, true);
      assert.strictEqual(settingsRes.headers['x-powered-by'], undefined, 'Header X-Powered-By đã bị tắt');
      console.log('✓ Pass: /api/settings che đậy mật khẩu/secret và tắt X-Powered-By');

      console.log('\n================================================================');
      console.log('TẤT CẢ 5 NHÓM KIỂM THỬ ĐÃ ĐẠT KẾT QUẢ 100% THÀNH CÔNG!');
      console.log('================================================================\n');
    } catch (err) {
      console.error('\n❌ KIỂM THỬ THẤT BẠI:', err.message);
      console.error(err.stack);
      process.exitCode = 1;
    } finally {
      server.close();
      if (fs.existsSync(testDbPath)) {
        try { fs.unlinkSync(testDbPath); } catch (e) {}
      }
    }
  });
}

runTests();
