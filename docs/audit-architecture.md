# BÁO CÁO KIỂM TOÁN KIẾM TRÚC HỆ THỐNG (AUDIT ARCHITECTURE)
**Hệ thống Lịch làm việc UBND Xã Nghĩa Lâm**

---

## 1. Tổng quan kiến trúc

Hệ thống **UBND Calendar** là ứng dụng web quản lý và hiển thị lịch công tác dành cho UBND Xã Nghĩa Lâm, phục vụ hai đối tượng chính:
1. **Trang Quản trị & Điều hành (`https://app.nghialam.com/lich/`)**: Cho phép cán bộ văn phòng tạo, sửa, xóa, tìm kiếm và duyệt lịch họp/công tác; cấu hình đồng bộ Google Calendar.
2. **Màn hình Tivi Kiosk (`https://app.nghialam.com/lich/tv.html`)**: Màn hình hiển thị công cộng chuyên dụng (Kiosk Mode) hiển thị lịch công tác hôm nay và 7 ngày tiếp theo với giao diện responsive, tự động cuộn/lật trang.

### Stack Công nghệ
- **Backend**: Node.js v18+, Express.js framework.
- **Database**: SQLite3 (`database.sqlite`) lưu trữ tập trung dữ liệu sự kiện.
- **Process Manager**: PM2 (chạy dưới tên process `app.nghialam.com`).
- **Web Server / Reverse Proxy**: Nginx (chuyển tiếp SSL HTTPS tới `http://localhost:3000`).
- **Frontend**: Single-Page Application (SPA) viết bằng Vanilla HTML5, CSS3, JavaScript (ES6+).
- **External Integration**: Google Apps Script / Google Calendar API (đồng bộ 2 chiều qua REST API / Webhook).

---

## 2. Luồng dữ liệu (Data Flow)

```
[Google Calendar] <--- (HTTPS JSON) ---> [Google Apps Script]
                                                |
                                                v (Push / Pull)
[Trình duyệt Admin] ---> (POST / PUT) ---> [Node.js Express Server] ---> [SQLite database.sqlite]
                                                |
[Màn hình TV Kiosk] <--- (GET /api/events) <----+
```

### Các Endpoint chính:
- `GET /api/events`: Lấy danh sách sự kiện theo dải ngày (`startDate`, `endDate`) và từ khóa (`query`).
- `GET /api/events/:id`: Lấy chi tiết 1 sự kiện.
- `POST /api/events`: Tạo sự kiện mới.
- `PUT /api/events/:id`: Cập nhật thông tin sự kiện.
- `DELETE /api/events/:id`: Xóa sự kiện.
- `POST /api/auth/login`: Xác thực mật khẩu quản trị và cấp phiên làm việc.
- `POST /api/auth/logout`: Hủy phiên làm việc.
- `GET /api/settings`: Lấy cấu hình hệ thống (đã che đậy secret).
- `POST /api/settings`: Cập nhật cấu hình hệ thống.
- `POST /api/sync-gcal`: Đồng bộ 2 chiều với Google Calendar.
- `POST /api/deploy-webhook`: Nhận GitHub Webhook tự động cập nhật mã nguồn.

---

## 3. Cơ sở dữ liệu (SQLite Schema)

Bảng `events`:
- `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
- `title` (TEXT NOT NULL): Nội dung/tiêu đề cuộc họp.
- `start_time` (TEXT NOT NULL): Thời gian bắt đầu (định dạng `YYYY-MM-DD HH:mm`).
- `end_time` (TEXT NOT NULL): Thời gian kết thúc (định dạng `YYYY-MM-DD HH:mm`).
- `chairperson` (TEXT NOT NULL): Người chủ trì.
- `location` (TEXT NOT NULL): Địa điểm tổ chức.
- `attendees` (TEXT): Thành phần tham dự.
- `preparing_unit` (TEXT): Đơn vị chuẩn bị.
- `category` (TEXT NOT NULL DEFAULT 'ubnd'): Phân loại (`ubnd`, `dang_uy`, `tiep_dan`, `thuc_dia`).
- `status` (TEXT NOT NULL DEFAULT 'scheduled'): Trạng thái (`scheduled`, `ongoing`, `completed`, `cancelled`, `postponed`).
- `document_link` (TEXT): Link tài liệu họp đính kèm (chỉ chấp nhận HTTPS).
- `gcal_id` (TEXT): ID định danh sự kiện từ Google Calendar.
- `created_at` (DATETIME DEFAULT CURRENT_TIMESTAMP).
