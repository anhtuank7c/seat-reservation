# Bài 3 — Tiền và hàng không được "lệch nhau"

← [Bài 2](./02-hold-ttl.md) · [Mục lục](./README.md) · ➡️ [Bài 4 — Webhook](./04-webhook-idempotency.md)

## Mục tiêu

- Hiểu vì sao **không thể** gói "trừ tiền" và "đặt ghế" vào chung một transaction.
- Hiểu thứ tự **giữ-ghế-trước-khi-trừ-tiền** (hold-before-charge) và vì sao nó quan trọng.
- Hiểu trường hợp tệ nhất: **đã trừ tiền nhưng mất ghế**, và cách xử lý bằng **compensation/refund**.
- Bắt đầu làm quen khái niệm **eventual consistency** giữa hai hệ thống.

> Đây là invariant số 2 — và là phần *khó nhất* dự án: **tiền và hàng (inventory) không bao giờ lệch nhau.**

---

## 1. Câu chuyện đời thường

Bạn ra quầy mua vé. Có hai việc phải xảy ra:

1. **Bạn đưa tiền** (việc này do *ngân hàng / cổng thanh toán* xử lý — một hệ thống **bên ngoài**).
2. **Nhân viên ghi tên bạn vào sổ ghế** (việc này do *hệ thống của chúng ta* xử lý).

Vấn đề: hai việc này nằm ở **hai nơi khác nhau**, không thể "cùng đúng hoặc cùng sai" một cách hoàn
hảo. Hãy hình dung các tình huống dở khóc dở cười:

- Bạn đưa tiền xong, nhưng đúng lúc đó cuốn sổ ghế bị giật mất / ghế vừa bị người khác lấy → **bạn mất
  tiền mà không có ghế**. Đây là kết cục **tệ nhất**.
- Nhân viên ghi tên bạn vào sổ trước, rồi mới đòi tiền, nhưng bạn bỏ chạy → **ghế bị khóa nhưng không
  có tiền**.

Một kỹ sư giỏi phải **lường trước** những tình huống này *trước khi* sếp kịp hỏi.

---

## 2. Vì sao không gói chung vào một transaction?

> **Transaction (giao dịch)**: một nhóm thao tác trên database hoặc "tất cả cùng thành công" hoặc
> "tất cả cùng hủy" (atomic — không có nửa vời).

Bạn có thể nghĩ: "Đơn giản! Gói cả trừ tiền lẫn đặt ghế vào một transaction là xong." Nhưng **không
được**, vì việc trừ tiền nằm ở **Stripe / ngân hàng — một hệ thống bên ngoài**, không nằm trong
database của bạn. Bạn không thể "rollback" (hoàn tác) một giao dịch đã gửi sang ngân hàng chỉ bằng
lệnh database.

Khi hai hệ thống độc lập phải phối hợp mà không thể chung một transaction, ta không thể có **strong
consistency** (luôn nhất quán tức thì). Thay vào đó ta nhắm tới **eventual consistency**: có thể lệch
nhau trong giây lát, nhưng hệ thống có cơ chế để *cuối cùng* kéo chúng về khớp nhau — ở đây cơ chế đó
là **hoàn tiền (refund)**.

---

## 3. Quyết định thiết kế #1: Giữ ghế TRƯỚC khi trừ tiền

Thứ tự rất quan trọng. Dự án chọn: **HELD trước, charge sau.** Nhìn lại luồng:

1. `holdSeat` → ghế chuyển sang **HELD** (Bài 1, 2).
2. `pay` → chỉ tạo yêu cầu thanh toán *cho ghế mà bạn đang giữ hợp lệ*.
3. `confirmPayment` → khi tiền về, mới ghi **RESERVED**.

Xem `pay` tại `src/reservation-service.ts:157` — nó **từ chối** trừ tiền nếu bạn không thực sự đang
giữ ghế hợp lệ:

```ts
const seat = await this.store.getSeat(seatId);
if (!seat) throw new ReservationError('NO_SUCH_SEAT', 'No such seat');
if (seat.status !== SeatStatus.HELD || seat.heldBy !== session.userId) {
  throw new ReservationError('NOT_HELD_BY_YOU', 'You must hold the seat before paying');
}
if (seat.heldUntil === null || seat.heldUntil <= now) {
  throw new ReservationError('HOLD_EXPIRED', 'Your hold has expired');
}
```

👉 **Bài học thiết kế:** giữ ghế trước giúp ta *gần như chắc chắn* có ghế khi tiền về. Nó không loại
bỏ 100% rủi ro (hold vẫn có thể hết hạn ngay sau khi bạn bấm trả tiền — xem mục 5), nhưng nó thu hẹp
khe hở rủi ro xuống mức nhỏ nhất, và phần còn lại được xử lý bằng refund.

---

## 4. Sổ cái: Payment và Reservation LÀ bằng chứng

Khi bắt đầu thanh toán, hệ thống ghi ngay một bản ghi `Payment` trạng thái **PENDING** (đang chờ) —
*trước cả khi* biết kết quả (`src/reservation-service.ts:178`):

```ts
// Record a PENDING payment up-front: the Payment/Reservation rows ARE the audit log.
let payment = await this.store.findPaymentByKey(idempotencyKey);
if (!payment) {
  payment = new Payment({ /* ... status: PaymentStatus.PENDING ... */ });
  await this.store.putPayment(payment);
}
```

> **Audit log (sổ cái / nhật ký kiểm toán):** khi liên quan đến **tiền**, mọi thay đổi phải tái dựng
> được. Hai bảng `Payment` và `Reservation` chính là sổ cái: nhìn vào đó luôn trả lời được "ai đã trả
> tiền, bao nhiêu, cho ghế nào, kết quả ra sao". Không bao giờ "trừ tiền âm thầm" mà không để lại dấu.

---

## 5. Trường hợp tệ nhất: đã trừ tiền nhưng mất ghế → REFUND

Đây là phần đắt giá nhất của bài. Khi tiền về (`confirmPayment`), hệ thống **kiểm tra lại** xem hold
còn hợp lệ không *trước khi* ghi RESERVED (`src/reservation-service.ts:227`):

```ts
const seat = await this.store.getSeat(payment.seatId);
const holdValid =
  seat !== null &&
  seat.status === SeatStatus.HELD &&
  seat.heldBy === payment.userId &&
  seat.heldUntil !== null &&
  seat.heldUntil > now;

if (!holdValid || seat === null) {
  // Đã trả tiền, nhưng ghế không còn (hold hết hạn / bị lấy mất).
  // Đền bù: HOÀN TIỀN, tuyệt đối không giữ tiền mà không giao ghế.
  return this._refund(payment);
}
```

> **Compensation (đền bù):** khi một bước đã "lỡ" thực hiện (đã trừ tiền) nhưng bước sau thất bại
> (không có ghế), ta không thể rollback bước trước, nên ta chạy một **hành động ngược lại** để bù
> đắp — ở đây là hoàn tiền. Đây là ý tưởng cốt lõi của mẫu thiết kế **Saga** trong các hệ phân tán.

Hàm `_refund` (`src/reservation-service.ts:272`):

```ts
private async _refund(payment: Payment): Promise<ConfirmResult> {
  if (payment.providerRef) this.gateway.refund(payment.providerRef);
  payment.status = PaymentStatus.REFUNDED;
  await this.store.putPayment(payment);
  return { payment, reservation: null, refunded: true };
}
```

Triết lý ở đây rõ ràng: **thà hoàn tiền còn hơn âm thầm giữ tiền của khách mà không giao ghế.** Mất
chút phí giao dịch còn hơn mất niềm tin và vướng pháp lý.

Còn nếu thanh toán **bị từ chối** (declined)? Hệ thống đánh dấu `Payment` là `FAILED` và **để yên cho
hold tự hết hạn** (`src/reservation-service.ts:221`) — không cần làm gì vội, lazy expiry (Bài 2) sẽ
dọn:

```ts
if (type === 'payment.failed') {
  payment.status = PaymentStatus.FAILED;
  await this.store.putPayment(payment);
  return { payment, reservation: null }; // để hold tự lapse
}
```

---

## 6. Còn một cú "lệch ghế" tinh vi nữa

Giả sử hold *vẫn còn hợp lệ*, nhưng đúng lúc ghi `Reservation` thì phát hiện **ai đó đã đặt ghế này
trước** (qua lớp `UNIQUE(seat_id)` ở Bài 1). Code xử lý rất cẩn thận (`src/reservation-service.ts:256`):

```ts
} catch (err) {
  if (!(err instanceof Error) || err.message !== 'SEAT_ALREADY_RESERVED') throw err;

  const existing = await this.store.findReservationBySeat(payment.seatId);
  if (existing && existing.userId === payment.userId) {
    // Hóa ra reservation đó là CỦA CHÍNH MÌNH (webhook gửi trùng) → coi như thành công, KHÔNG hoàn tiền.
    payment.status = PaymentStatus.SUCCEEDED;
    await this.store.putPayment(payment);
    return { payment, reservation: existing, replayed: true };
  }
  // Thua ghế vào tay người khác sau khi đã trừ tiền → hoàn tiền.
  return this._refund(payment);
}
```

Hai nhánh quan trọng:

- Nếu reservation đã tồn tại là **của chính mình** → đây chỉ là webhook trùng (Bài 4), **không** hoàn
  tiền, trả về kết quả cũ.
- Nếu là **của người khác** → mình đã trả tiền nhưng mất ghế → **hoàn tiền**.

👉 Phân biệt được "trùng của mình" với "thua người khác" là dấu hiệu của tư duy nghiệp vụ chín chắn.

---

## 7. Test chứng minh

**Test #6 — đã trả tiền nhưng hold hết hạn → refund, không có reservation** (`reservation.test.ts:104`):

```ts
await app.reservations.holdSeat(a.token, SEAT);
const { event } = await app.reservations.pay(a.token, SEAT, 'success'); // trừ tiền lúc hold còn hợp lệ
app.clock.advance(60_001);                                              // ...rồi hold hết hạn trước khi tiền về

const result = await app.reservations.confirmPayment(event);
assert.equal(result.refunded, true);
assert.equal(result.payment.status, PaymentStatus.REFUNDED);
assert.equal(result.reservation, null);
assert.ok((await app.store.getSeat(SEAT))!.isClaimableAt(app.clock.now())); // ghế lại trống
```

**Test #7 — thanh toán bị từ chối → không reservation; hold tự hết hạn** (`reservation.test.ts:120`).

---

## 8. Bài tập & câu hỏi thảo luận

1. Giải thích cho một người không học IT: vì sao "trừ tiền" và "đặt ghế" lại **không thể** đảm bảo
   cùng thành công 100%? Vai trò của refund trong câu chuyện này là gì?
2. Dự án chọn **hold-before-charge**. Hãy thử kịch bản ngược lại — *charge-before-hold* (trừ tiền
   trước, giữ ghế sau). Liệt kê những tình huống xấu mới phát sinh.
3. Trong nhánh `catch SEAT_ALREADY_RESERVED`, vì sao việc phân biệt "reservation của mình" và "của
   người khác" lại dẫn tới hai hành động hoàn toàn khác nhau? Nếu code *luôn luôn* refund ở nhánh này
   thì hậu quả là gì?
4. Khi declined, code "để hold tự hết hạn" thay vì thả ghế ngay. Đây là một lựa chọn có chủ đích.
   Nêu một lý do *ủng hộ* và một lý do *phản đối* lựa chọn này.
5. **Liên hệ:** tra cứu mẫu thiết kế **Saga pattern** trong hệ phân tán. Hàm `_refund` của dự án
   tương ứng với khái niệm nào trong Saga?

---

← [Bài 2](./02-hold-ttl.md) · [Mục lục](./README.md) · ➡️ [Bài 4 — Webhook: lặp lại, sai thứ tự & giả mạo](./04-webhook-idempotency.md)
