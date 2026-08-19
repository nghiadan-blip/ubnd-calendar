#!/bin/bash
# ==============================================================================
# KỊCH BẢN TỰ ĐỘNG CẬP NHẬT & DEPLOY HỆ THỐNG UBND XÃ NGHĨA LÂM (AAPANEL VPS)
# ==============================================================================

echo "======================================================================"
echo "🚀 Bắt đầu quá trình Cập nhật & Deploy tự động..."
echo "======================================================================"

# 1. Chuyển vào thư mục dự án
TARGET_DIR="/www/wwwroot/app.nghialam.com"
if [ -d "$TARGET_DIR" ]; then
    cd "$TARGET_DIR"
    echo "📁 Đã chuyển vào thư mục: $TARGET_DIR"
else
    echo "📁 Đang chạy tại thư mục hiện tại: $(pwd)"
fi

# 2. Xóa bỏ tất cả thay đổi cục bộ và pull code mới nhất từ GitHub
echo "🔄 Xóa bỏ xung đột rác và kéo code mới từ origin/master..."
git fetch --all
git reset --hard origin/master
git pull origin master

# 3. Khởi động lại dịch vụ Node.js qua PM2
echo "♻ Khởi động lại ứng dụng PM2..."
if command -v pm2 &> /dev/null; then
    pm2 restart all || pm2 reload all
else
    echo "⚠️ PM2 không tìm thấy trong PATH hệ thống."
fi

# 4. Reload lại Nginx trên aaPanel
echo "🌐 Reload lại Nginx trên aaPanel..."
if [ -f /etc/init.d/nginx ]; then
    /etc/init.d/nginx reload
elif command -v nginx &> /dev/null; then
    nginx -s reload
fi

echo "======================================================================"
echo "✅ TẤT CẢ QUÁ TRÌNH CẬP NHẬT ĐÃ HOÀN TẤT THÀNH CÔNG!"
echo "======================================================================"
