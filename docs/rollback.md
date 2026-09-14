# QUY TRÌNH KHÔI PHỤC VÀ ROLLBACK (ROLLBACK PROCEDURE)
**Hệ thống Lịch làm việc UBND Xã Nghĩa Lâm**

---

## 1. Trường hợp cần kích hoạt Rollback

Quá trình khôi phục sự cố (Rollback) **phải được thực hiện ngay lập tức** nếu xuất hiện một trong các dấu hiệu sau sau khi triển khai:
1. Màn hình TV (`/lich/tv.html`) hoặc Trang quản trị (`/lich/`) bị lỗi HTTP 500 / 502 hoặc giao diện trắng.
2. API `/api/events` không phản hồi hoặc báo lỗi truy vấn cơ sở dữ liệu.
3. Tiến trình PM2 liên tục bị crash và tự khởi động lại (Restart loop).
4. Dữ liệu sự kiện công tác trên màn hình bị biến dạng hoặc mất mát.

---

## 2. Kế hoạch Khôi phục Nhanh (Fast Rollback Steps)

### Bước 1: Khôi phục mã nguồn Git về Commit SHA an toàn gần nhất
```bash
# Xem nhật ký commit trước đó
git log --oneline -n 5

# Checkout quay lại commit ổn định trước đó (Ví dụ SHA: 04c5679)
git checkout master
git reset origin/master
```
*(Ghi chú: Luôn đảm bảo không dùng `--hard` để bảo vệ các file không nằm trong git tracking)*

### Bước 2: Khôi phục Cơ sở dữ liệu SQLite & Cấu hình từ bản Sao lưu gần nhất
```bash
# Xác định bản sao lưu mới nhất trong thư mục backup ngoài Git
ls -la ../backups/

# Khôi phục file database.sqlite
cp ../backups/database.sqlite.bak-YYYYMMDD-HHMMSS database.sqlite

# Khôi phục file settings.json
cp ../backups/settings.json.bak-YYYYMMDD-HHMMSS settings.json
```

### Bước 3: Khởi động lại dịch vụ PM2
```bash
pm2 reload app.nghialam.com --update-env
```

### Bước 4: Tự động Kiểm tra Xác nhận (Sanity Check)
```bash
# Kiểm tra API phản hồi thành công mã HTTP 200
curl -i http://localhost:3000/api/events

# Kiểm tra log ứng dụng không còn lỗi
pm2 logs app.nghialam.com --lines 20
```
