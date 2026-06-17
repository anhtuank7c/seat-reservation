# Khóa học System Design qua dự án "Đặt chỗ ngồi" (Seat Reservation)

> Một khóa học nhỏ, dành cho **người mới đi làm (junior)**, dạy bạn cách **suy nghĩ như một
> kỹ sư hệ thống** thông qua một bài toán tưởng đơn giản nhưng đầy cạm bẫy: *đặt một chỗ ngồi*.

## Vì sao lại học qua dự án này?

Hầu hết khóa học System Design dạy bạn vẽ sơ đồ to đùng (load balancer, cache, message queue...).
Nhưng khi đi làm, thứ làm sập hệ thống và làm mất tiền của công ty thường **không phải** là sơ đồ to,
mà là những lỗi nhỏ và rất khó thấy:

- Hai người mua **cùng một ghế** trong cùng một giây → bán trùng (*double-booking*).
- Khách hàng **bị trừ tiền nhưng không có ghế** → mất niềm tin, hoàn tiền thủ công, mất uy tín.
- Cổng thanh toán gửi thông báo **2 lần** → hệ thống tạo 2 đơn, trừ tiền 2 lần.
- Một người gửi thông báo **giả** "tôi đã trả tiền" → chiếm ghế miễn phí.

Dự án này **cố tình bỏ đi** giao diện, database, framework, HTTP — những thứ làm rối — và chỉ giữ lại
đúng phần **logic nghiệp vụ khó nhất**, nơi những lỗi trên thực sự xảy ra. Nhờ vậy bạn nhìn thẳng vào
bản chất vấn đề.

> Triết lý của repo (trích `README.md`): *"strip away the database, framework, and transport and
> keep only the logic where those risks live, then proves it with executable tests."*

## Cách dùng thuật ngữ trong khóa học

Khóa viết bằng **tiếng Việt**, nhưng **giữ nguyên thuật ngữ tiếng Anh** (race condition, idempotency,
compare-and-set...) vì đó là những từ bạn sẽ gặp hằng ngày khi đi làm và khi đọc tài liệu. Mỗi thuật
ngữ đều được giải thích ngắn gọn ở lần xuất hiện đầu tiên.

## Lộ trình các bài học

| Bài | Tên | Thử thách của hệ thống (system challenge) |
|---|---|---|
| [Bài 0](./00-tong-quan.md) | Tổng quan & "máy trạng thái" của một chiếc ghế | Mô hình hóa nghiệp vụ thành *state machine* |
| [Bài 1](./01-race-condition.md) | Race condition & chống bán trùng ghế | Concurrency, *compare-and-set*, unique constraint |
| [Bài 2](./02-hold-ttl.md) | Giữ chỗ tạm (hold), TTL & khách bỏ giỏ hàng | Inventory tự phục hồi, *lazy expiry* |
| [Bài 3](./03-payment-consistency.md) | Tiền và hàng không được "lệch nhau" | Phối hợp 2 hệ thống không cùng transaction, *compensation/refund* |
| [Bài 4](./04-webhook-idempotency.md) | Webhook: lặp lại, sai thứ tự, và giả mạo | Idempotency, *HMAC signature*, độ tin cậy |
| [Bài 5](./05-auth-security.md) | Đăng nhập, session 90 ngày & quyền sở hữu | AuthN/AuthZ, *session revocation*, IDOR |
| [Bài 6](./06-testability-tradeoffs.md) | Làm sao chứng minh hệ thống đúng? | *Dependency injection*, testability, trade-off |

Đề xuất học **theo thứ tự**, vì các bài sau dựa vào khái niệm của bài trước. Mỗi bài gồm:

1. **Mục tiêu** — học xong bạn làm được gì.
2. **Câu chuyện đời thường** — một ví dụ ngoài đời để "cảm" được vấn đề trước khi nói code.
3. **Lý thuyết & thuật ngữ** — khái niệm cốt lõi.
4. **Đọc code thật** — chỉ rõ `tên-file:dòng` để bạn mở ra xem.
5. **Test chứng minh** — bài toán này được kiểm chứng bằng test nào.
6. **Bài tập & câu hỏi thảo luận** — để tự luyện và để giảng viên hỏi trên lớp.

## Chuẩn bị môi trường (để chạy thử code)

Cần **Node ≥ 22.18** (hoặc ≥ 23.6). Repo chạy file `.ts` trực tiếp, không cần build.

```bash
# Vào thư mục dự án
cd seat-reservation

# Chạy toàn bộ bộ test nghiệp vụ (12 test) — đây là "bằng chứng" cho mỗi bài học
node --test

# Xem một kịch bản được kể lại từng bước
node demo.ts
```

> Nếu Node của bạn cũ hơn (22.6–22.17), thêm cờ `--experimental-strip-types`, hoặc dùng
> `npx tsx --test` / `npx tsx demo.ts`.

## Gợi ý cho giảng viên

- Mỗi bài có thể dạy trong **1 buổi (~90 phút)**: 30 phút lý thuyết + đời thường, 30 phút đọc code &
  chạy test trực tiếp trên máy chiếu, 30 phút bài tập/thảo luận.
- "Vũ khí" mạnh nhất của khóa này là cặp hàm `holdSeat` (đúng) và `holdSeatNaive` (**cố tình sai**).
  Hãy chạy test #2 và #3 trước lớp để học viên *thấy tận mắt* lỗi bán trùng xuất hiện rồi biến mất.
- Khuyến khích học viên **sửa cho hỏng** (ví dụ: thêm `await` vào giữa critical section) rồi chạy lại
  test để thấy nó vỡ — học bằng cách phá vỡ là cách nhớ lâu nhất.

---

➡️ Bắt đầu: [Bài 0 — Tổng quan & máy trạng thái của một chiếc ghế](./00-tong-quan.md)
