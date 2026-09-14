# ĐÁNH GIÁ VÀ PHÁT HIỆN LỖI BẢO MẬT (SECURITY FINDINGS)
**Hệ thống Lịch làm việc UBND Xã Nghĩa Lâm**

---

## 1. Danh sách lỗ hổng P0 / P1 phát hiện qua kiểm toán

### [P0-1] Xác thực quản trị bị bỏ qua (Bypass Auth & Fail-Open)
- **Mô tả**: Trong `server.js`, middleware `requireAuth` kiểm tra token nhưng luôn gọi `next()`, kể cả khi không có token hoặc token sai. Endpoint `/api/auth/login` luôn trả thành công với token cố định `'NghiaLam@2026'`. Trên Frontend, nếu có tham số `?mode=admin` hoặc `?pass=NghiaLam@2026`, giao diện tự động bật quyền admin và lưu mật khẩu thô vào `sessionStorage`.
- **Rủi ro**: Bất kỳ người dùng công cộng nào truy cập URL đều có thể tạo, sửa, xóa toàn bộ lịch công tác của UBND xã.
- **Biện pháp khắc phục**:
  - Triển khai cơ chế xác thực dựa trên Session Cookie (`HttpOnly`, `Secure`, `SameSite=Strict`) hoặc Token mã hóa có thời hạn.
  - Sửa `requireAuth` thành **fail-closed** (trả 401 Unauthorized nếu không có phiên hợp lệ).
  - Loại bỏ hoàn toàn mật khẩu hardcode và các tham số `?mode=admin`, `?pass=...`.
  - Thêm Rate Limiting cho `/api/auth/login` (tối đa 5 lần thử sai / phút).

### [P0-2] GitHub Deploy Webhook thiếu xác thực chữ ký (Insecure Webhook Execution)
- **Mô tả**: Endpoint `POST /api/deploy-webhook` cho phép qua nếu chưa thiết lập `webhookSecret`. Ngoài ra, khi nhận tín hiệu webhook, server sử dụng `exec()` chạy lệnh chuỗi shell và trả toàn bộ `stdout`/`stderr` hệ thống về client.
- **Rủi ro**: Kẻ tấn công có thể gửi request giả mạo tới `/api/deploy-webhook` để kích hoạt lệnh shell hoặc thu thập thông tin cấu hình VPS qua `stdout`.
- **Biện pháp khắc phục**:
  - Vô hiệu hóa webhook nếu chưa cấu hình secret (`fail-closed`).
  - Kiểm tra chữ ký HMAC SHA-256 (`X-Hub-Signature-256`) bằng `crypto.timingSafeEqual()`.
  - Giới hạn webhook chỉ nhận event push từ nhánh `refs/heads/master` và repository hợp lệ.
  - Không trả chi tiết `stdout`/`stderr` hệ thống ra phản hồi HTTP.

### [P0-3] Nguy cơ Server-Side Request Forgery (SSRF) tại Endpoint `/api/sync-gcal`
- **Mô tả**: Endpoint `/api/sync-gcal` nhận tham số `appsScriptUrl` trực tiếp từ client request body và thực hiện `fetch(targetUrl, { redirect: 'follow' })` tới URL đó mà không kiểm tra tên miền hay IP.
- **Rủi ro**: Kẻ tấn công có thể truyền các URL nội bộ (`http://127.0.0.1`, `http://169.254.169.254`, các cổng dịch vụ nội bộ) để quét hoặc lấy thông tin nhạy cảm của VPS.
- **Biện pháp khắc phục**:
  - Yêu cầu quyền quản trị viên đối với việc kích hoạt đồng bộ thủ công.
  - URL Google Apps Script bắt buộc phải được lấy từ cấu hình server (`settings.json`).
  - Validate URL: Chỉ cho phép giao thức `https://`, tên miền thuộc `script.google.com` hoặc `script.googleusercontent.com`. Chặn toàn bộ IP nội bộ/loopback và không tự động chuyển hướng ra ngoài allowlist.

### [P1-1] Nguy cơ Stored XSS do chèn dữ liệu động vào `innerHTML`
- **Mô tả**: Trong `public/app.js` và `public/tv.html`, dữ liệu từ API (`title`, `chairperson`, `location`, `attendees`, `document_link`) được ghép trực tiếp vào chuỗi HTML thông qua `innerHTML`.
- **Rủi ro**: Nếu kẻ tấn công chèn mã JavaScript độc hại vào tiêu đề hoặc địa điểm lịch công tác (qua Google Calendar hoặc API), mã script sẽ thực thi trên trình duyệt của cán bộ quản trị hoặc màn hình TV.
- **Biện pháp khắc phục**:
  - Sử dụng hàm escape HTML chuyên dụng hoặc khởi tạo DOM qua `document.createElement()` và `textContent`.
  - Kiểm tra và chỉ cho phép liên kết tài liệu `document_link` bắt đầu bằng `https://`.

### [P1-2] Thiếu Cấu hình Header Bảo mật & CORS
- **Mô tả**: Server chưa bật các header bảo mật cơ bản như `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, và đang trả về header `X-Powered-By: Express`.
- **Biện pháp khắc phục**: Tích hợp các middleware bảo mật chuẩn (Helmet), tắt `x-powered-by`, cấu hình CORS giới hạn strict same-origin.
