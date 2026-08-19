/**
 * GOOGLE APPS SCRIPT WEB APP - ĐỒNG BỘ LỊCH, TỰ ĐỘNG TẠO DRIVE FOLDER & GỬI EMAIL THÔNG BÁO
 * 
 * Hướng dẫn cài đặt:
 * 1. Truy cập https://script.google.com và đăng nhập bằng tài khoản Google của UBND xã.
 * 2. Bấm "Dự án mới" (New Project).
 * 3. Copy toàn bộ mã nguồn file này dán vào khung soạn thảo mã (xóa hết code cũ).
 * 4. Thay đổi danh bạ CAN_BO_DIRECTORY bên dưới theo đúng địa chỉ email thực tế của xã.
 * 5. Bấm biểu tượng "Lưu" (Save).
 * 6. Bấm nút "Triển khai" (Deploy) -> "Triển khai mới" (New deployment).
 *    - Chọn loại cấu hình: "Ứng dụng web" (Web app)
 *    - Mô tả: "API Lịch UBND xã - Bản tự động hóa"
 *    - Thực thi dưới quyền: "Tôi" (Me - tài khoản Google của bạn)
 *    - Ai có quyền truy cập: "Bất kỳ ai" (Anyone - để Web App khách kết nối)
 * 7. Bấm "Triển khai" (Deploy) và cấp quyền truy cập tài khoản Google (Calendar, Drive, Gmail) cho script.
 * 8. Copy lấy đường dẫn "URL ứng dụng web" và dán vào phần cấu hình (Settings) trên trang Web.
 */

// Đặt ID của Google Calendar. Nhập 'primary' để dùng Lịch chính.
const CALENDAR_ID = 'primary';

// DANH BẠ EMAIL CÁN BỘ XÃ - Tự động ánh xạ khi gửi email thông báo
const CAN_BO_DIRECTORY = {
  'chủ tịch': 'chutich.nghialam@gmail.com',
  'phó chủ tịch': 'pct.nghialam@gmail.com',
  'nguyễn hùng cường': 'chutich.nghialam@gmail.com',
  'lô xuân du': 'pct.loxuandu@gmail.com',
  'nguyễn huy anh': 'pct.nguyenhuyanh@gmail.com',
  'địa chính': 'diachinh.nghialam@gmail.com',
  'tư pháp': 'tuphap.nghialam@gmail.com',
  'văn phòng': 'vanphong.nghialam@gmail.com',
  'công an': 'congan.nghialam@gmail.com',
  'quân sự': 'quansu.nghialam@gmail.com',
  'đoàn thanh niên': 'doan.thanhnien.nghialam@gmail.com'
};

/**
 * Xử lý yêu cầu GET: Đọc lịch từ Google Calendar
 */
function doGet(e) {
  try {
    const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
    if (!calendar) {
      return createJsonResponse({ error: 'Không tìm thấy Google Calendar với ID đã cấu hình.' });
    }

    let start = new Date();
    start.setDate(start.getDate() - 30);
    let end = new Date();
    end.setDate(end.getDate() + 30);

    if (e && e.parameter) {
      if (e.parameter.startDate) start = new Date(e.parameter.startDate);
      if (e.parameter.endDate) end = new Date(e.parameter.endDate);
    }

    const events = calendar.getEvents(start, end);
    const result = events.map(function(evt) {
      return {
        id: evt.getId(),
        title: evt.getTitle(),
        start_time: formatEventDate(evt.getStartTime()),
        end_time: formatEventDate(evt.getEndTime()),
        location: evt.getLocation(),
        description: evt.getDescription(),
        chairperson: parseDescriptionField(evt.getDescription(), 'Chủ trì'),
        attendees: parseDescriptionField(evt.getDescription(), 'Thành phần'),
        preparing_unit: parseDescriptionField(evt.getDescription(), 'Chuẩn bị'),
        category: parseDescriptionField(evt.getDescription(), 'Phân loại') || 'ubnd',
        document_link: parseDescriptionField(evt.getDescription(), 'Tài liệu họp'),
        status: 'scheduled'
      };
    });

    return createJsonResponse(result);
  } catch (error) {
    return createJsonResponse({ error: 'Lỗi đọc lịch: ' + error.toString() });
  }
}

/**
 * Xử lý yêu cầu POST: Ghi lịch, Tự tạo Drive Folder, Gửi Email
 */
function doPost(e) {
  try {
    const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
    if (!calendar) {
      return createJsonResponse({ error: 'Không tìm thấy Google Calendar.' });
    }

    // Đọc body dữ liệu
    const data = JSON.parse(e.postData.contents);
    const title = data.title;
    const startTime = new Date(data.start_time);
    const endTime = new Date(data.end_time);
    const location = data.location || '';
    const chairperson = data.chairperson || '';
    const attendees = data.attendees || '';
    const preparingUnit = data.preparing_unit || '';
    const category = data.category || 'ubnd';
    let documentLink = data.document_link || '';

    // 1. TỰ ĐỘNG TẠO THƯ MỤC GOOGLE DRIVE NẾU ĐƯỢC YÊU CẦU HOẶC RỖNG
    if (data.auto_create_drive === true && !documentLink) {
      documentLink = createDriveFolderForEvent(title, data.start_time);
    }

    // Gộp thông tin chi tiết vào phần mô tả của Google Calendar
    const description = 
      "Chủ trì: " + chairperson + "\n" +
      "Thành phần: " + attendees + "\n" +
      "Chuẩn bị: " + preparingUnit + "\n" +
      "Phân loại: " + category + "\n" +
      "Tài liệu họp: " + documentLink;

    let calendarEvent;
    
    // Nếu có google_event_id, tiến hành cập nhật sự kiện cũ
    if (data.google_event_id || data.id) {
      calendarEvent = calendar.getEventById(data.google_event_id || data.id);
    }

    if (calendarEvent) {
      // Cập nhật sự kiện có sẵn
      calendarEvent.setTitle(title);
      calendarEvent.setTime(startTime, endTime);
      calendarEvent.setLocation(location);
      calendarEvent.setDescription(description);
    } else {
      // Tạo sự kiện mới
      calendarEvent = calendar.createEvent(title, startTime, endTime, {
        location: location,
        description: description
      });
    }

    // 2. GỬI EMAIL THÔNG BÁO TỰ ĐỘNG
    let emailSent = false;
    let recipientsList = [];
    if (data.send_email === true) {
      recipientsList = findEmailsForAttendees(attendees);
      if (recipientsList.length > 0) {
        // Gửi email
        const eventDataForEmail = {
          title: title,
          start_time: data.start_time,
          end_time: data.end_time,
          location: location,
          chairperson: chairperson,
          attendees: attendees,
          preparing_unit: preparingUnit,
          document_link: documentLink
        };
        sendEmailNotification(eventDataForEmail, recipientsList);
        emailSent = true;
      }
    }

    return createJsonResponse({
      success: true,
      google_event_id: calendarEvent.getId(),
      document_link: documentLink,
      email_sent: emailSent,
      recipients: recipientsList,
      message: 'Đã lưu lịch họp, đồng bộ Drive & gửi email thành công!'
    });
  } catch (error) {
    return createJsonResponse({ error: 'Lỗi ghi lịch & tự động hóa: ' + error.toString() });
  }
}

// ==========================================================================
// CÁC TÍNH NĂNG TỰ ĐỘNG HÓA (DRIVE & EMAIL)
// ==========================================================================

/**
 * Tự động tạo thư mục trên Google Drive
 */
function createDriveFolderForEvent(eventName, eventDateStr) {
  try {
    // Tìm hoặc tạo thư mục gốc của UBND xã trên Drive
    const parentFolderName = "LICH_CONG_TAC_UBND_XA";
    const folders = DriveApp.getFoldersByName(parentFolderName);
    let parentFolder;
    if (folders.hasNext()) {
      parentFolder = folders.next();
    } else {
      parentFolder = DriveApp.createFolder(parentFolderName);
    }

    // Tạo thư mục riêng cho cuộc họp (Định dạng: YYYYMMDD - Tên cuộc họp)
    const datePrefix = eventDateStr.split(' ')[0].replace(/[-]/g, '');
    const folderName = datePrefix + " - " + eventName;
    const newFolder = parentFolder.createFolder(folderName);
    
    // Đặt quyền chia sẻ công khai qua link (chỉ xem)
    newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    return newFolder.getUrl();
  } catch (err) {
    console.error("Lỗi khi tạo Drive Folder: " + err.toString());
    return "";
  }
}

/**
 * Quét chuỗi thành phần tham dự để tìm các email tương ứng trong danh bạ
 */
function findEmailsForAttendees(attendeesText) {
  if (!attendeesText) return [];
  const emails = [];
  const text = attendeesText.toLowerCase();

  for (const key in CAN_BO_DIRECTORY) {
    if (text.indexOf(key) !== -1) {
      const email = CAN_BO_DIRECTORY[key];
      if (emails.indexOf(email) === -1) {
        emails.push(email);
      }
    }
  }
  return emails;
}

/**
 * Gửi email thông báo định dạng HTML chuyên nghiệp
 */
function sendEmailNotification(eventData, recipients) {
  if (!recipients || recipients.length === 0) return;

  const subject = "[UBND XÃ NGHĨA LÂM] THÔNG BÁO LỊCH CÔNG TÁC: " + eventData.title;
  const startTime = eventData.start_time;
  const endTime = eventData.end_time.split(' ')[1];
  
  // Link sinh QR Code tự động từ Link tài liệu Google Drive
  const qrCodeUrl = eventData.document_link 
    ? "https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=" + encodeURIComponent(eventData.document_link)
    : "";

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; border: 1px solid #E2E8F0; border-radius: 16px; padding: 24px; color: #334155; margin: 0 auto;">
      <div style="text-align: center; border-bottom: 3px solid #059669; padding-bottom: 14px; margin-bottom: 20px;">
        <h2 style="color: #059669; margin: 0; font-size: 22px; font-weight: bold; letter-spacing: 0.5px;">ỦY BAN NHÂN DÂN XÃ NGHĨA LÂM</h2>
        <p style="margin: 6px 0 0 0; font-size: 13px; color: #64748B; text-transform: uppercase; font-weight: 600; letter-spacing: 1px;">Thông báo lịch làm việc tự động</p>
      </div>
      
      <p style="font-size: 15px; line-height: 1.6;">Kính gửi các đồng chí thành viên, bộ phận liên quan,</p>
      <p style="font-size: 15px; line-height: 1.6;">Văn phòng UBND xã xin thông báo lịch công tác/cuộc họp mới vừa được phê duyệt trên hệ thống:</p>
      
      <div style="background-color: #F8FAFC; border-left: 5px solid #0EA5E9; padding: 18px; margin: 20px 0; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
        <h3 style="margin: 0 0 14px 0; color: #0F172A; font-size: 16px; font-weight: bold; line-height: 1.4;">${eventData.title}</h3>
        <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
          <tr>
            <td style="width: 110px; padding: 6px 0; color: #64748B; vertical-align: top;"><strong>Thời gian:</strong></td>
            <td style="padding: 6px 0; font-weight: bold; color: #0F172A;">${startTime} - ${endTime}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748B; vertical-align: top;"><strong>Chủ trì:</strong></td>
            <td style="padding: 6px 0; font-weight: bold; color: #0F172A;">${eventData.chairperson}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748B; vertical-align: top;"><strong>Địa điểm:</strong></td>
            <td style="padding: 6px 0; font-weight: bold; color: #0F172A;">${eventData.location}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748B; vertical-align: top;"><strong>Thành phần:</strong></td>
            <td style="padding: 6px 0; color: #334155;">${eventData.attendees}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748B; vertical-align: top;"><strong>Chuẩn bị:</strong></td>
            <td style="padding: 6px 0; color: #334155;">${eventData.preparing_unit || 'Văn phòng UBND'}</td>
          </tr>
        </table>
      </div>
      
      ${eventData.document_link ? `
      <div style="margin-top: 24px; background-color: #ECFDF5; border: 1px dashed #10B981; padding: 18px; border-radius: 12px; display: flex; align-items: center; justify-content: space-between;">
        <div style="flex: 1; padding-right: 15px;">
          <h4 style="margin: 0 0 8px 0; color: #065F46; font-size: 15px; font-weight: bold;">📁 TÀI LIỆU GOOGLE DRIVE</h4>
          <p style="margin: 0 0 12px 0; font-size: 12.5px; color: #047857; line-height: 1.4;">Quét mã QR bên cạnh bằng Zalo/Camera điện thoại để đọc tài liệu họp hoặc nhấn trực tiếp nút dưới:</p>
          <a href="${eventData.document_link}" target="_blank" style="display: inline-block; background-color: #10B981; color: white; text-decoration: none; padding: 8px 16px; border-radius: 8px; font-weight: bold; font-size: 13px; box-shadow: 0 2px 4px rgba(16,185,129,0.2);">Xem thư mục tài liệu</a>
        </div>
        ${qrCodeUrl ? `<div style="text-align: center; width: 100px; flex-shrink: 0;"><img src="${qrCodeUrl}" style="width: 90px; height: 90px; display: block; margin: 0 auto 4px auto;"><span style="font-size: 10px; color: #047857; font-weight: 600;">Quét xem tài liệu</span></div>` : ''}
      </div>
      ` : ''}
      
      <p style="margin-top: 30px; font-size: 12px; color: #94A3B8; text-align: center; border-top: 1px solid #E2E8F0; padding-top: 18px;">
        Đồng chí nhận được email này vì thuộc thành phần tham dự hoặc đơn vị chuẩn bị cuộc họp.<br>
        Đây là thư tự động từ hệ thống Quản lý Lịch UBND xã, vui lòng không trả lời thư này.
      </p>
    </div>
  `;

  MailApp.sendEmail({
    to: recipients.join(','),
    subject: subject,
    htmlBody: htmlBody
  });
}

// ----------------------------------------------------
// CÁC HÀM TRỢ GIÚP (HELPERS)
// ----------------------------------------------------

function formatEventDate(date) {
  const pad = function(n) { return n < 10 ? '0' + n : n; };
  return date.getFullYear() + '-' +
         pad(date.getMonth() + 1) + '-' +
         pad(date.getDate()) + ' ' +
         pad(date.getHours()) + ':' +
         pad(date.getMinutes());
}

function createJsonResponse(data) {
  const jsonString = JSON.stringify(data);
  return ContentService.createTextOutput(jsonString)
    .setMimeType(ContentService.MimeType.JSON);
}

function parseDescriptionField(description, key) {
  if (!description) return '';
  const lines = description.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(key + ':') === 0) {
      return lines[i].substring(key.length + 1).trim();
    }
  }
  return '';
}
