---
name: harness-core
description: Logic cốt lõi của harness: vai trò tay chân, cổng CLI, cây dữ liệu zone/class, đăng ký công cụ, guard/approval/data-gate, audit/observe, doctor. Dùng khi cần đọc/ghi dữ liệu harness, thêm một tool mới, hoặc tra lệnh harness.
---

# Harness core

## Nguyên tắc
- Tay chân: việc máy làm được thì máy làm (kiểm tra tất định, quét, dọn, báo cáo). Agent chỉ phân tích và phán đoán.
- Mọi dữ liệu và cấu hình của harness đi qua một cổng duy nhất, không đọc/ghi file thô.

## Cổng CLI
- `harness <domain> <lệnh>`; chạy không đối số để xem danh sách domain, `harness <domain> --help` để xem lệnh và cờ.
- Chưa có lệnh cho dữ liệu cần đọc: bổ sung lệnh vào extension (có limit/timeout, `--raw` để gỡ lỗi), đăng ký domain trong `manifest.json` của extension, rồi mới dùng. Đọc thô chỉ là ngoại lệ khi chưa kịp bổ sung.
- Hook và doctor là ngoại lệ: gọi trực tiếp, không qua cổng.
- Data-gate (hook) chặn lệnh đọc/ghi thẳng vào thư mục dữ liệu; thấy báo chặn thì đổi sang `harness data ...` hoặc `harness observe ...`.

## Cây dữ liệu
- Zone: `system` (audit, registry, trạng thái máy), `knowledge` (tri thức), `workspaces` (dữ liệu theo không gian làm việc), `external` (nguồn ngoài), `_inbox` (chưa phân loại, chờ `adopt`).
- Mỗi tool ghi dữ liệu có một class, quyết định retention: `log` (xoay vòng, xóa sớm), `cache` (dựng lại được), `artifact` (kết quả có hạn dùng), `durable` (giữ lâu, không tự xóa).
- Đăng ký trước lần ghi đầu: `harness data register <zone>/<domain|ws>/<tool> --class <log|cache|artifact|durable>`. Thiếu đăng ký hệ thống tự cảnh báo.
- Dọn: `harness data ls|stat|scan|clean|prune|sizes`; mặc định dry-run, chỉ xóa khi có `--yes`.

## Guard, approval, audit
- Guard (hook) chặn hành vi nguy hiểm trước khi chạy: ghi/xóa hàng loạt, đọc dữ liệu thô, push/deploy. Hành vi cần người duyệt đi qua approval; không tự lách bằng cách đổi đường.
- Mọi sự kiện công cụ được ghi audit. Đọc bằng `harness observe view|why|query|digest|runs|cost`, không mở file audit.
- Doctor kiểm cấu hình, hook, đăng ký và cảnh báo lệch; chạy `harness build doctor` sau khi đổi cấu hình hay thêm tool.

## Thêm một tool mới đúng chuẩn
1. Đặt tool trong thư mục extension riêng, kèm `manifest.json`: id, kind, entry, domain, desc, cmds, tests, data.
2. Nếu tool ghi dữ liệu: đăng ký zone/class (`data register`) trước khi chạy lần đầu.
3. Lệnh có timeout và giới hạn đọc; hết hạn thì dừng êm và báo `truncated`.
4. Viết test cạnh tool; dữ liệu thử đặt trong thư mục tạm, xóa khi xong.
5. Chạy doctor; không để lại file rác, tiến trình nền hay dữ liệu chưa đăng ký.
6. Cấu hình mặc định nằm trong code; chỉ thêm config khi mặc định không đủ.
