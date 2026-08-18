const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Không thể kết nối tới cơ sở dữ liệu SQLite:', err.message);
    process.exit(1);
  }
  console.log('Đã kết nối thành công tới database.sqlite');
});

db.serialize(() => {
  // Tạo bảng events lưu lịch họp/công tác
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('Lỗi khi tạo bảng events:', err.message);
      return;
    }
    console.log('Đã khởi tạo bảng SQL "events" thành công.');
  });

  // Xóa dữ liệu cũ nếu có để khởi tạo lại sạch sẽ
  db.run(`DELETE FROM events`, (err) => {
    if (err) {
      console.error('Lỗi khi làm sạch bảng:', err.message);
    }
  });

  // Dữ liệu mẫu tuần công tác UBND Xã từ 13/07/2026 đến 19/07/2026
  const sampleEvents = [
    {
      title: 'Chào cờ đầu tuần và Họp giao ban Thường trực Đảng ủy, HĐND, UBND xã tuần 29',
      start_time: '2026-07-13 07:30',
      end_time: '2026-07-13 11:30',
      chairperson: 'Đ/c Nguyễn Văn A - Chủ tịch UBND xã',
      location: 'Phòng họp tầng 2',
      attendees: 'Thường trực Đảng ủy, HĐND, UBND, Trưởng công an xã, Chỉ huy trưởng Quân sự, Văn phòng UBND',
      preparing_unit: 'Văn phòng UBND',
      category: 'dang_uy',
      status: 'scheduled',
      document_link: 'https://docs.google.com/document/d/1tY8XN9oMockDocID1/edit'
    },
    {
      title: 'Ký duyệt hồ sơ đất đai và giải quyết thủ tục hành chính tại bộ phận Một cửa',
      start_time: '2026-07-13 14:00',
      end_time: '2026-07-13 17:00',
      chairperson: 'Đ/c Lê Văn B - Phó Chủ tịch UBND xã',
      location: 'Bộ phận Tiếp nhận và Trả kết quả (Một cửa)',
      attendees: 'Công chức Địa chính - Xây dựng, Văn phòng UBND',
      preparing_unit: 'Bộ phận Một cửa',
      category: 'ubnd',
      status: 'scheduled',
      document_link: ''
    },
    {
      title: 'Tổ chức Hội nghị đối thoại trực tiếp giữa Người đứng đầu cấp ủy, chính quyền với nhân dân xã',
      start_time: '2026-07-14 08:00',
      end_time: '2026-07-14 11:30',
      chairperson: 'Bí thư Đảng ủy & Chủ tịch UBND xã',
      location: 'Hội trường lớn UBND xã',
      attendees: 'Toàn thể cán bộ công chức, Ủy viên BCH Đảng bộ, Trưởng các ngành đoàn thể, Bí thư chi bộ, Trưởng thôn và Đại diện nhân dân xã',
      preparing_unit: 'Văn phòng Đảng ủy & UBMTTQ xã',
      category: 'dang_uy',
      status: 'scheduled',
      document_link: 'https://docs.google.com/document/d/1tY8XN9oMockDocID2/edit'
    },
    {
      title: 'Kiểm tra thực địa tiến độ thi công bê tông hóa đường giao thông nông thôn tại Thôn 3',
      start_time: '2026-07-14 14:00',
      end_time: '2026-07-14 17:00',
      chairperson: 'Đ/c Lê Văn B - Phó Chủ tịch UBND xã',
      location: 'Hiện trường thi công Thôn 3',
      attendees: 'Ban Giám sát đầu tư cộng đồng, Trưởng thôn 3, Công chức Địa chính - Xây dựng',
      preparing_unit: 'Ban Chỉ đạo giao thông xã',
      category: 'thuc_dia',
      status: 'scheduled',
      document_link: ''
    },
    {
      title: 'Họp triển khai kế hoạch tổng rà soát hộ nghèo, hộ cận nghèo năm 2026 trên địa bàn xã',
      start_time: '2026-07-15 08:00',
      end_time: '2026-07-15 11:30',
      chairperson: 'Đ/c Trần Thị C - Phó Chủ tịch UBND xã (Văn hóa - Xã hội)',
      location: 'Phòng họp tầng 2',
      attendees: 'Thành viên Ban chỉ đạo giảm nghèo xã, các Trưởng thôn',
      preparing_unit: 'Công chức Lao động - Thương binh & Xã hội',
      category: 'ubnd',
      status: 'scheduled',
      document_link: 'https://docs.google.com/document/d/1tY8XN9oMockDocID3/edit'
    },
    {
      title: 'Sinh hoạt Chi bộ Cơ quan UBND xã triển khai Nghị quyết quý III',
      start_time: '2026-07-15 14:00',
      end_time: '2026-07-15 17:00',
      chairperson: 'Bí thư Chi bộ Cơ quan UBND xã',
      location: 'Phòng họp tầng 2',
      attendees: 'Toàn thể đảng viên Chi bộ Cơ quan UBND xã',
      preparing_unit: 'Chi ủy Chi bộ cơ quan',
      category: 'dang_uy',
      status: 'scheduled',
      document_link: ''
    },
    {
      title: 'Lãnh đạo UBND xã tiếp công dân định kỳ tuần 29 năm 2026',
      start_time: '2026-07-16 08:00',
      end_time: '2026-07-16 11:30',
      chairperson: 'Đ/c Nguyễn Văn A - Chủ tịch UBND xã',
      location: 'Phòng Tiếp công dân UBND xã',
      attendees: 'Công chức Tư pháp - Hộ tịch, Địa chính, Thanh tra nhân dân',
      preparing_unit: 'Văn phòng UBND',
      category: 'tiep_dan',
      status: 'scheduled',
      document_link: 'https://docs.google.com/document/d/1tY8XN9oMockDocID4/edit'
    },
    {
      title: 'Hội nghị tuyên truyền phổ biến pháp luật phòng cháy, chữa cháy và cứu nạn, cứu hộ cho các hộ kinh doanh',
      start_time: '2026-07-16 14:00',
      end_time: '2026-07-16 16:30',
      chairperson: 'Đ/c Lê Văn B - Phó Chủ tịch UBND xã',
      location: 'Hội trường lớn UBND xã',
      attendees: 'Công an xã, các hộ kinh doanh, nhà nghỉ, karaoke trên địa bàn',
      preparing_unit: 'Công an xã',
      category: 'ubnd',
      status: 'scheduled',
      document_link: ''
    },
    {
      title: 'Họp Ủy ban Kiểm tra Đảng ủy xã để giải quyết đơn thư kiến nghị, khiếu nại của cử tri',
      start_time: '2026-07-17 08:00',
      end_time: '2026-07-17 11:30',
      chairperson: 'Chủ nhiệm Ủy ban Kiểm tra Đảng ủy xã',
      location: 'Phòng họp Đảng ủy',
      attendees: 'Thành viên UBKT Đảng ủy xã, Công chức Tư pháp - Hộ tịch',
      preparing_unit: 'Ủy ban Kiểm tra Đảng ủy',
      category: 'dang_uy',
      status: 'scheduled',
      document_link: 'https://docs.google.com/document/d/1tY8XN9oMockDocID5/edit'
    },
    {
      title: 'Họp Hội đồng Nghĩa vụ quân sự xã rà soát nguồn công dân trong độ tuổi nhập ngũ chuẩn bị cho năm 2027',
      start_time: '2026-07-17 14:00',
      end_time: '2026-07-17 17:00',
      chairperson: 'Đ/c Nguyễn Văn A - Chủ tịch UBND xã',
      location: 'Phòng họp tầng 2',
      attendees: 'Thành viên Hội đồng NVQS xã, các Trưởng thôn, Thôn đội trưởng',
      preparing_unit: 'Ban Chỉ huy Quân sự xã',
      category: 'ubnd',
      status: 'scheduled',
      document_link: 'https://docs.google.com/document/d/1tY8XN9oMockDocID6/edit'
    }
  ];

  const stmt = db.prepare(`
    INSERT INTO events (title, start_time, end_time, chairperson, location, attendees, preparing_unit, category, status, document_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  sampleEvents.forEach((event) => {
    stmt.run(
      event.title,
      event.start_time,
      event.end_time,
      event.chairperson,
      event.location,
      event.attendees,
      event.preparing_unit,
      event.category,
      event.status,
      event.document_link
    );
  });

  stmt.finalize((err) => {
    if (err) {
      console.error('Lỗi khi chèn dữ liệu mẫu:', err.message);
    } else {
      console.log('Đã nạp thành công 10 lịch công tác mẫu vào cơ sở dữ liệu SQL.');
    }
    db.close();
  });
});
