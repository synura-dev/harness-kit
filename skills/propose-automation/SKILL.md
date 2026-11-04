---
name: propose-automation
description: Quyết định khi nào và bằng cách nào tạo hook, lịch hoặc tool tự động. Dùng khi người dùng nói "từ giờ / mỗi lần X", khi một bước thủ công lặp khoảng 3 lần, hoặc khi một dữ kiện cần kiểm tra lại định kỳ.
---

# Propose automation

Tạo tự động hóa theo nhu cầu, không làm trước. Đề xuất trước, không cài âm thầm.

## Nguyên tắc
Máy làm được thì máy làm: bước tất định (kiểm tra, quét, dọn, báo cáo) thành mã chạy tự động; agent chỉ giữ phần phán đoán.

## Các bước
1. **Kích hoạt.** Một trong: quy tắc thường trực ("từ giờ khi X": cần hook, ghi nhớ không cưỡng chế được); bước thủ công lặp khoảng 3 lần; dữ kiện cũ cần kiểm tra lại.
2. **Chọn cơ chế** (kiểm tra tài liệu hiện hành nếu không chắc, ghi "chưa xác nhận" khi chưa kiểm):
   - Phản ứng theo sự kiện (kết thúc phiên, trước/sau gọi công cụ): hook.
   - Định kỳ, cần file/MCP cục bộ, máy bật: tác vụ lịch trên máy, hoặc cron theo phiên (mất khi đóng phiên).
   - Định kỳ, máy có thể tắt, không cần file cục bộ: lịch trên đám mây.
   - Bước lặp có đầu vào/đầu ra rõ: một tool nhỏ có test, đăng ký đúng chuẩn.
3. **Đề xuất** tối đa 6 dòng: mục đích, cơ chế, điều kiện kích hoạt hoặc cron, lệnh sẽ chạy, rủi ro, cách gỡ. Hook chạy lệnh với quyền người dùng, nên chờ duyệt.
4. **Bắt đầu an toàn:** chỉ thông báo hoặc ghi log; thêm hành vi chặn/sửa khi đã tin cậy.
5. **Tạo** bằng công cụ cấu hình có sẵn, không sửa tay file cấu hình nếu đã có công cụ.
   - Nếu tự động hóa ghi dữ liệu: `harness data register <zone>/<domain|ws>/<tool> --class <log|cache|artifact|durable>` trước lần ghi đầu.
6. **Ghi sổ:** tên, loại, mục đích, ngày tạo, ngày xem lại, trạng thái.
7. **Xem lại** đúng hạn: xem log, giữ/chỉnh/xóa, ghi kết quả vào sổ.

## Quy tắc
- Điều chưa xác minh về hook/lịch phải gắn nhãn "chưa xác nhận" hoặc kiểm tra tài liệu trước.
- Tự động hóa dùng model rẻ nhất và ít công cụ nhất đủ việc.
