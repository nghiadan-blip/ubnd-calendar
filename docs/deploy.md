# QUY TRÌNH TRIỂN KHAI VÀ BẢO TRÌ (DEPLOYMENT GUIDE)
**Hệ thống Lịch làm việc UBND Xã Nghĩa Lâm**

---

## 1. Môi trường triển khai
- **Server VPS**: Linux / Ubuntu.
- **Thư mục ứng dụng**: `/www/wwwroot/app.nghialam.com`
- **Tên Process PM2**: `app.nghialam.com` (Process ID: 10)
- **Tên nhánh Git Production**: `master`
- **Tên nhánh Git Development / Feature**: `fix/tv-display`

---

## 2. Các bước triển khai chuẩn (Staging & Production)

### Bước 1: Kiểm tra an toàn trước khi Deploy
1. Đảm bảo toàn bộ kiểm thử tự động (Unit Test / Integration Test) chạy thành công 100%:
   `npm test`
2. Thực hiện sao lưu cơ sở dữ liệu SQLite production và cấu hình:
   - Cơ sở dữ liệu: `database.sqlite` -> `database.sqlite.bak-YYYYMMDD-HHMMSS`
   - Cấu hình: `settings.json` -> `settings.json.bak-YYYYMMDD-HHMMSS`
3. Kiểm tra file backup hợp lệ và có kích thước lớn hơn 0 byte.

### Bước 2: Cập nhật mã nguồn từ nhánh `master`
```bash
git fetch origin master
git merge origin/master --ff-only
```
*(Tuyệt đối không sử dụng `git reset --hard` hoặc `git clean` trên môi trường Production)*

### Bước 3: Kiểm tra các gói phụ thuộc (Dependencies)
```bash
npm ci --only=production
```

### Bước 4: Khởi động lại ứng dụng an toàn với PM2
```bash
pm2 reload app.nghialam.com --update-env
```
*(Sử dụng `pm2 reload` thay vì `pm2 restart` để tránh làm gián đoạn dịch vụ)*

### Bước 5: Kiểm tra trực tiếp sau khi Deploy (Post-deploy Healthcheck)
1. Kiểm tra trạng thái process PM2:
   `pm2 show app.nghialam.com`
2. Kiểm tra phản hồi HTTP API local:
   `curl -f http://localhost:3000/api/events`
3. Kiểm tra trang web thật công khai:
   `curl -I https://app.nghialam.com/lich/`
   `curl -I https://app.nghialam.com/lich/tv.html`
