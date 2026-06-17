# Bài 6 — Làm sao chứng minh hệ thống đúng? Testability & trade-off

← [Bài 5](./05-auth-security.md) · [Mục lục](./README.md)

## Mục tiêu

- Hiểu vì sao **testability** (khả năng kiểm thử) là một quyết định *thiết kế*, không phải việc làm thêm cuối cùng.
- Hiểu **dependency injection** (tiêm phụ thuộc) qua hai ví dụ thật: đồng hồ và cổng thanh toán.
- Hiểu vì sao việc **tiêm thời gian** vào hệ thống mở khóa cho gần như mọi test khó nhằn.
- Học cách trình bày **trade-off** (đánh đổi) — kỹ năng được đánh giá cao nhất ở kỹ sư senior.

---

## 1. Câu chuyện đời thường

Bạn muốn kiểm tra "session hết hạn sau 90 ngày" có hoạt động không. Cách ngây thơ: chạy hệ thống rồi
**chờ 90 ngày**. Vô lý!

Hoặc bạn muốn kiểm tra "đã trả tiền nhưng hold hết hạn → hoàn tiền" (Bài 3). Bạn cần một lần thanh toán
*thật* qua Stripe, một cái hold *thật* hết hạn đúng khoảnh khắc đó. Gần như không thể dựng lại theo ý
muốn.

Vấn đề chung: hệ thống phụ thuộc vào hai thứ **khó điều khiển** — **thời gian** và **dịch vụ bên
ngoài**. Nếu để code gọi thẳng `Date.now()` và gọi thẳng API Stripe, bạn *không thể* test các tình
huống quan trọng nhất. Giải pháp: **đừng để code tự lấy những thứ đó — hãy tiêm chúng từ ngoài vào.**

---

## 2. Dependency Injection (tiêm phụ thuộc) là gì?

> **Dependency Injection (DI):** thay vì một class *tự tạo* những thứ nó cần (đồng hồ, cổng thanh
> toán, store), ta **đưa (tiêm)** chúng vào từ bên ngoài, thường qua hàm khởi tạo (constructor). Nhờ
> đó, lúc chạy thật ta tiêm "đồ thật", còn lúc test ta tiêm "đồ giả có thể điều khiển".

Nhìn constructor của `ReservationService` (`src/reservation-service.ts:67`) — nó **không tự tạo** gì
cả, mọi thứ được đưa vào:

```ts
constructor({ store, clock, gateway, auth, idGen, holdTtlMs = ..., amount = ... }: ReservationDeps) {
  this.store = store;     // store được tiêm
  this.clock = clock;     // đồng hồ được tiêm
  this.gateway = gateway; // cổng thanh toán được tiêm
  // ...
}
```

Những "khớp nối" (seam) cho phép tráo đồ thật ↔ đồ giả này chính là chìa khóa của testability.

---

## 3. Ví dụ 1: Thời gian là một *input*, không phải thứ tự lấy

Thay vì gọi `Date.now()` rải rác khắp nơi, dự án định nghĩa một interface `Clock` rất nhỏ
(`src/clock.ts:9`):

```ts
export interface Clock { now(): number; }

export class SystemClock implements Clock {        // dùng thật: đồng hồ hệ thống
  now(): number { return Date.now(); }
}

export class FakeClock implements Clock {          // dùng test: đồng hồ điều khiển được
  private _now: number;
  constructor(startMs = 0) { this._now = startMs; }
  now(): number { return this._now; }
  advance(ms: number): number { this._now += ms; return this._now; }   // "tua" thời gian
}
```

Nhờ vậy, mọi quy tắc phụ thuộc thời gian — TTL của hold (Bài 2), hạn 90 ngày (Bài 5) — đều test được
bằng cách **tua đồng hồ giả** thay vì chờ đợi. Bạn đã thấy `app.clock.advance(...)` xuất hiện trong
rất nhiều test:

```ts
app.clock.advance(60_001);          // làm một hold hết hạn (test #4, #6)
app.clock.advance(NINETY_DAYS_MS);  // vượt qua mốc 90 ngày (test #8)
```

👉 **Bài học thiết kế:** coi thời gian là một **input của hệ thống** (cũng như dữ liệu người dùng) mở
khóa cho cả một lớp test mà nếu không thì *bất khả thi*. Đây có lẽ là quyết định kiến trúc đem lại
nhiều lợi ích nhất trong toàn dự án.

---

## 4. Ví dụ 2: Cổng thanh toán giả lập

Tương tự, ta không gọi Stripe thật. `MockPaymentGateway` (`src/payment-gateway.ts:46`) mô phỏng đúng
*hình dạng* của một cổng thật (tạo intent → capture → gửi webhook đã ký), nhưng cho phép test **chọn
trước kết quả** (`src/payment-gateway.ts:76`):

```ts
capture(intentId: string, scenario: CaptureScenario = 'success'): WebhookEvent {
  // scenario: 'success' | 'decline'
  if (scenario === 'decline') { /* trả về sự kiện payment.failed */ }
  // ...trả về payment.succeeded
}
```

Nhờ vậy test có thể dựng *mọi nhánh* — thành công, bị từ chối, hoàn tiền, webhook giả — mà **không cần
tài khoản Stripe, không cần mạng, không tốn tiền thật**. Test #7 chỉ việc gọi `pay(..., 'decline')`
để mô phỏng thẻ bị từ chối.

Một điểm tinh tế nữa giúp test ổn định: `idGen` cũng được tiêm và **sinh id tuần tự** (`id_1`, `id_2`...)
thay vì ngẫu nhiên (`src/app.ts:10`), nên mỗi lần chạy test cho ra kết quả y hệt — gọi là test **tất
định (deterministic)**.

---

## 5. Nơi lắp ráp tất cả: `createApp`

Tất cả các "khớp nối" được ráp lại đúng **một chỗ** — `createApp` trong `src/app.ts:35`:

```ts
export async function createApp({ clock, latencyMs = 0, holdTtlMs, seatCount = 3 }) {
  const idGen = createIdGen();
  const store = new InMemoryStore({ latencyMs });
  const auth = new AuthService({ store, clock, idGen });
  const gateway = new MockPaymentGateway({ clock, idGen });
  const reservations = new ReservationService({ store, clock, gateway, auth, idGen, holdTtlMs });
  // ...tạo sẵn seatCount ghế
}
```

Chạy thật thì truyền `SystemClock`; chạy test thì truyền `FakeClock` và `latencyMs` để ép race
condition (Bài 1). Cùng một đoạn code lõi, hai "thế giới" khác nhau. Đây là sức mạnh của việc gom
**phần lắp ráp** (wiring) tách khỏi **phần logic**.

---

## 6. Trade-off: nghệ thuật của việc "cắt đúng chỗ"

Phần này quan trọng cho phỏng vấn. Dự án **cố tình bỏ bớt** nhiều thứ, nhưng mỗi cái đều kèm *lý do*
và *đường đi lên production*. Trích từ `docs/ASSESSMENT_ANALYSIS.md`:

| Quyết định | Trong dự án | Đường lên production | Vì sao chấp nhận được |
|---|---|---|---|
| Lưu trữ | `Map` trong bộ nhớ | Postgres / SQLite | Ngữ nghĩa concurrency đã mô phỏng bằng CAS — *logic* y hệt |
| Điều khiển tương tranh | Optimistic locking (versioned compare-and-swap) | Pessimistic locking (`SELECT ... FOR UPDATE`) | Cùng một invariant; đổi store, giữ nguyên service |
| Hết hạn hold | Lazy + sweeper tùy chọn | Cron / queue nền | Lazy expiry tự đúng; sweeper chỉ để gọn |
| Session | Server-side, revocable | DB session / signed cookie | Mô phỏng đúng 90 ngày *và* thu hồi được |
| Thanh toán | Mock gateway | Stripe + webhook thật | Vẫn luyện idempotency, ký, refund — không cần tài khoản |
| Đăng nhập | Passwordless | Magic link / OAuth | Cơ chế đăng nhập là chi tiết tích hợp, không phải lõi |
| Transport | Không có (logic thuần) | HTTP API + UI | Invariant nghiệp vụ nằm *dưới* tầng transport |

> **Bài học lớn nhất của cả khóa:** kỹ sư giỏi không phải người làm *nhiều tính năng nhất*, mà là
> người **cắt đúng chỗ**: giữ lại phần rủi ro/khó nhất (concurrency, tiền↔hàng), bỏ phần phụ, và
> **giải thích rõ ràng vì sao** cùng đường đi nếu cần làm tiếp. "Khả năng giải thích các đánh đổi"
> chính là một tiêu chí chấm điểm.

---

## 7. Bài tập & câu hỏi thảo luận

1. Tự mình giải thích: nếu `ReservationService` gọi thẳng `Date.now()` thay vì dùng `clock` được
   tiêm, thì *những test nào* (trong 12 test) sẽ trở nên bất khả thi hoặc không ổn định? Vì sao?
2. `idGen` sinh id tuần tự thay vì ngẫu nhiên. Nêu một lợi ích cho việc test và một rủi ro nếu lỡ
   dùng `idGen` kiểu này ở môi trường thật.
3. **Thực hành DI:** giả sử bạn muốn thêm tính năng "gửi email xác nhận sau khi đặt ghế". Bạn sẽ thiết
   kế seam (khớp nối) nào để vẫn test được mà không gửi email thật? Phác thảo interface đó.
4. Chọn **một** dòng trong bảng trade-off ở mục 6. Đóng vai bạn đang phỏng vấn và người hỏi nói:
   "Sao không làm luôn bản production?". Hãy trả lời trong 3-4 câu, vừa bảo vệ lựa chọn vừa cho thấy
   bạn biết đường đi tiếp theo.
5. **Tổng kết khóa học:** viết một đoạn 5-7 câu trả lời câu hỏi: *"Phần khó thật sự của một hệ thống
   đặt chỗ là gì, và hệ thống này bảo vệ nó bằng những cơ chế nào?"* — coi như câu trả lời phỏng vấn
   của chính bạn.

---

## Tổng kết toàn khóa

Bạn đã đi qua đủ các thử thách cốt lõi mà một hệ thống nghiệp vụ phải đối mặt:

| Bài | Thử thách | Vũ khí phòng thủ |
|---|---|---|
| 1 | Bán trùng dưới tương tranh | optimistic locking (compare-and-swap) + `UNIQUE` constraint |
| 2 | Khách bỏ giỏ hàng, kho bị kẹt | TTL + lazy expiry |
| 3 | Tiền và hàng lệch nhau | hold-before-charge + refund/compensation |
| 4 | Webhook lặp / giả mạo | idempotency key + chữ ký HMAC |
| 5 | Mạo danh & truy cập trái phép | session revocable + ownership check (chống IDOR) |
| 6 | Làm sao chứng minh tất cả đều đúng | dependency injection + test tất định |

Sợi chỉ đỏ xuyên suốt: **xác định đúng invariant (điều luôn-luôn-đúng), rồi để mọi dòng code phục vụ
việc bảo vệ nó** — và **chứng minh bằng test chạy được**, không phải bằng lời hứa.

---

← [Bài 5](./05-auth-security.md) · [Quay lại Mục lục](./README.md)
