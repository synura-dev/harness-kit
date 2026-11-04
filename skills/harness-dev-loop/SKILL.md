---
name: harness-dev-loop
description: "Vòng phát triển nhiều agent song song, rút từ số liệu chạy thật: chia gói, trần song song, brief, trần lượt, commit từng mục, tự sửa rồi hoàn tác, full suite một lần, reviewer độc lập. Dùng khi lập kế hoạch hoặc chạy một đợt việc nhiều bước."
---

# Harness dev loop

Nhãn: [số liệu: lệnh] = lấy từ cổng harness (cửa sổ 3 ngày tính đến 2026-10-30, chạy lại lệnh để cập nhật); [quy tắc] = quy ước, chưa có số liệu kiểm chứng.

## Số liệu thật
- 614 lượt chạy: general-purpose 359, builder 70, verifier 49, reviewer 37, scout 23, planner 12 [số liệu: `harness observe cost summary --since 3d --by role`]. (verifier agent da bo 2026-11-04, thay bang playbook verify-project)
- Model: sonnet 471, haiku 90, opus 53; 42 lượt được đánh dấu "có thể dùng model rẻ hơn" (40 trên opus) [số liệu: `harness observe cost summary --since 3d --by model`].
- Chi phí quy ra tiền: chưa có số liệu (bảng giá chưa cập nhật, cost=null).
- 253 commit trong 3 ngày: feat 65, refactor 63, fix 39, docs 36, chore 23, test 16, revert 0 [số liệu: `git log --since=3.days --pretty=%s`, đếm theo tiền tố].
- Fix chiếm 39/253 commit: sửa lỗi là chuyện thường, nên commit nhỏ để mỗi lần sửa độc lập [số liệu: lệnh git ở trên].
- Số lần chạm trần lượt, tỉ lệ tự sửa thành công, thời gian mỗi gói: chưa có số liệu (cổng chưa trả).

## Quy trình
1. **Hỏi đủ một lần.** Trước khi chạy, thu thập mọi thông tin cần (đường dẫn, quyền, ngưỡng, phạm vi); kế hoạch được duyệt thì chạy đến hết, không hỏi lại. [quy tắc]
2. **Chia gói theo file.** Mỗi gói sở hữu tập file riêng, không gói nào sửa file của gói khác; đụng nhau thì làm tuần tự hoặc dồn về một gói. [quy tắc]
3. **Trần song song.** Tối đa 2-3 agent/tiến trình nặng cùng lúc; hai suite không dùng chung một cơ sở dữ liệu. [quy tắc]
4. **Brief tự đủ.** Mục tiêu, file liên quan (đường dẫn tuyệt đối), tiêu chí xong, điều cấm, nơi ghi báo cáo, độ dài báo cáo tối đa (khoảng 40 dòng). Agent không phải dò đường. [quy tắc]
5. **Trần lượt tool.** Nêu trần trong brief, yêu cầu báo cáo trước lượt N-2; chạm trần mà chưa báo cáo thì resume agent đó thay vì tạo mới. [quy tắc]
6. **Model theo việc.** Việc thực thi nhẹ dùng model rẻ, phân tích/phê bình dùng model mạnh; xem cột "cheaper_possible" để chỉnh. [số liệu: `observe cost summary --by model`]
7. **Commit từng mục.** Một mục logic một commit, chỉ `git add <file>` cụ thể, thông điệp ghi vào file rồi `git commit -F`. [quy tắc; phân bố commit ở trên]
8. **Tự sửa tối đa 2 lần.** Mục lỗi: sửa lần 1, lần 2; vẫn lỗi thì hoàn tác mục đó (revert hoặc bỏ thay đổi) và ghi lại, không sa lầy. [quy tắc]
9. **Một lần full suite.** Gói nhỏ chỉ chạy kiểm tra nhanh (kiểm kiểu + test liên quan); playbook/lệnh verify tất định (`harness play verify-project`) chạy full suite đúng một lần ở nền, log ra file, bọc timeout, không chạy lại khi chưa có thay đổi. [quy tắc]
10. **Reviewer độc lập.** Reviewer chỉ đọc diff, không dựa kết luận của builder; mỗi reviewer tối đa khoảng 8 PR/commit. [quy tắc]
11. **Dọn sau đợt.** Dừng tiến trình nền do mình khởi, kiểm tra tiến trình mồ côi, ghi quyết định và trạng thái vào sổ việc. [quy tắc]

## Rút số liệu cho đợt sau
Chạy lại các lệnh ở mục Số liệu thật với `--since` phù hợp; `harness observe runs list` cho các lần chạy gần nhất; `harness observe digest <YYYY-MM-DD>` cho tóm tắt ngày. Số liệu nào cổng không cho thì ghi "chưa có số liệu", không ước đoán.
