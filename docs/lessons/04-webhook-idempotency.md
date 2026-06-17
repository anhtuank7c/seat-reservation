# Bài 4 — Webhook: lặp lại, sai thứ tự, và giả mạo

← [Bài 3](./03-payment-consistency.md) · [Mục lục](./README.md) · ➡️ [Bài 5 — Auth & bảo mật](./05-auth-security.md)

## Mục tiêu

- Hiểu **webhook** là gì và vì sao nó là một "cánh cửa" đầy rủi ro.
- Hiểu **idempotency** (làm lại nhiều lần vẫn cho cùng kết quả) — khái niệm sống còn khi xử lý tiền.
- Hiểu vì sao webhook có thể đến **trùng lặp** hoặc **sai thứ tự**, và cách phòng.
- Hiểu chữ ký **HMAC** dùng để xác thực webhook là thật, và **constant-time comparison**.

---

## 1. Câu chuyện đời thường

Bạn trả tiền vé ở cổng thanh toán (ví dụ Stripe). Việc xử lý thẻ mất vài giây và xảy ra **ở phía họ**,
không phải phía bạn. Vậy làm sao hệ thống của bạn biết "khách đã trả tiền xong"?

Stripe sẽ **gọi ngược về** hệ thống bạn qua một URL công khai để báo "đơn X đã thanh toán thành công".
Cú gọi ngược đó gọi là **webhook**.

> **Webhook**: một hệ thống bên ngoài chủ động gửi HTTP request *tới* bạn để báo một sự kiện vừa xảy
> ra (thay vì bạn phải liên tục hỏi "xong chưa? xong chưa?").

Webhook tiện, nhưng kéo theo ba rủi ro lớn:

1. **Trùng lặp:** nhà cung cấp có thể gửi cùng một sự kiện **nhiều lần** (do mạng chập chờn, do họ
   retry khi chưa nhận được phản hồi "OK"). Bạn không được trừ tiền / tạo đơn 2 lần.
2. **Sai thứ tự:** sự kiện có thể đến không theo trình tự.
3. **Giả mạo:** URL webhook là **công khai** — bất kỳ ai trên Internet cũng có thể gửi một request giả
   "tôi đã trả tiền". Bạn phải chứng minh được request *thật sự* đến từ nhà cung cấp.

---

## 2. Rủi ro #1: Trùng lặp → cần Idempotency

> **Idempotency (tính bất biến khi lặp):** một thao tác mà dù bạn chạy **1 lần hay 100 lần** thì kết
> quả cuối cùng vẫn **y hệt nhau**. Ví dụ đời thường: bấm nút thang máy 10 lần thang vẫn chỉ đến một
> lần; còn "rút 100k từ ATM" thì *không* idempotent — làm 10 lần là mất 1 triệu.

Hàm xử lý webhook `confirmPayment` được thiết kế idempotent. Mở đầu, nó kiểm tra **trạng thái hiện
tại** của payment và *trả về kết quả cũ* nếu đã xử lý rồi (`src/reservation-service.ts:212`):

```ts
// (b) Idempotency — replays/retries return the prior outcome, never re-apply.
if (payment.status === PaymentStatus.SUCCEEDED) {
  const reservation = await this.store.findReservationBySeat(payment.seatId);
  return { payment, reservation, replayed: true };       // đã thành công rồi → trả lại đúng cái cũ
}
if (payment.status === PaymentStatus.FAILED || payment.status === PaymentStatus.REFUNDED) {
  return { payment, reservation: null, replayed: true };  // đã chốt số phận rồi → không làm lại
}
```

Mấu chốt để nhận ra "sự kiện này tôi xử lý chưa": mỗi thanh toán có một **idempotency key** ổn định,
được tạo từ thông tin của chính lần giữ ghế đó (`src/reservation-service.ts:171`):

```ts
// Stable per hold, so a retried checkout reuses the same charge instead of double-billing.
const idempotencyKey = `${session.userId}:${seatId}:${seat.heldUntil}`;
```

> **Idempotency key:** một "mã định danh duy nhất cho một ý định thao tác". Webhook nào mang cùng key
> này → cùng một thanh toán → chỉ xử lý một lần. Key được lưu kèm `UNIQUE` trong store
> (`_paymentByKey`, `src/store.ts:32`), nên không thể tạo hai payment trùng key.

Để ý cả cổng thanh toán cũng idempotent: gọi `createIntent` hai lần với cùng key sẽ trả về **cùng một
intent** thay vì tạo hai lần trừ tiền (`src/payment-gateway.ts:59`):

```ts
createIntent({ amount, idempotencyKey, metadata = {} }) {
  const existingId = this._intentByKey.get(idempotencyKey);
  if (existingId) return { ...this._intents.get(existingId)! };   // đã có → trả lại, không tạo mới
  // ...
}
```

👉 **Bài học thiết kế:** mọi thao tác liên quan đến tiền và đến hệ thống bên ngoài **phải** idempotent.
Mạng là thứ không đáng tin; retry là chuyện bình thường. Idempotency biến "retry" từ thảm họa thành
chuyện vô hại.

---

## 3. Rủi ro #3: Giả mạo → chữ ký HMAC

Vì URL webhook là công khai, hệ thống phải xác minh request **thật sự** đến từ nhà cung cấp. Cách làm:
nhà cung cấp và bạn cùng biết một **secret** (chuỗi bí mật). Nhà cung cấp dùng secret đó để "ký" lên
nội dung sự kiện, tạo ra một chữ ký **HMAC**. Bạn ký lại nội dung nhận được bằng cùng secret — nếu hai
chữ ký khớp, request là thật.

> **HMAC (Hash-based Message Authentication Code):** một "con dấu" tính từ *nội dung* + *secret chung*.
> Ai không biết secret thì không thể tạo ra con dấu đúng, dù họ thấy được nội dung. Nếu nội dung bị
> sửa một ký tự, con dấu cũng đổi hoàn toàn.

Mọi sự kiện đều được ký khi tạo (`src/payment-gateway.ts:107`):

```ts
private _signEvent(type: string, intent: PaymentIntent): WebhookEvent {
  const payload = { /* ... */ };
  const body = JSON.stringify(payload);
  return { payload, body, signature: this.sign(body) };   // đính kèm chữ ký
}

sign(body: string): string {
  return crypto.createHmac('sha256', this.secret).update(body).digest('hex');
}
```

Và việc **đầu tiên** `confirmPayment` làm — trước khi tin bất cứ điều gì — là xác minh chữ ký
(`src/reservation-service.ts:202`):

```ts
async confirmPayment(event: WebhookEvent): Promise<ConfirmResult> {
  // (a) Authenticity — never trust an unsigned/forged webhook.
  if (!this.gateway.verify(event.body, event.signature)) {
    throw new ReservationError('BAD_SIGNATURE', 'Invalid webhook signature');
  }
  // ...chỉ khi chữ ký hợp lệ mới xử lý tiếp
}
```

### Chi tiết nâng cao: so sánh chữ ký theo "thời gian hằng số"

Nhìn kỹ hàm `verify` (`src/payment-gateway.ts:96`):

```ts
verify(body: string, signature: string): boolean {
  const expected = this.sign(body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);   // ← so sánh constant-time
}
```

Vì sao không dùng `expected === signature` cho gọn? Vì phép `===` trên chuỗi thường **dừng sớm** ngay
khi gặp ký tự khác nhau đầu tiên. Kẻ tấn công có thể đo *thời gian phản hồi* để đoán dần từng ký tự
của chữ ký đúng — gọi là **timing attack**. `crypto.timingSafeEqual` luôn so sánh hết, mất thời gian
*như nhau* dù sai ở đâu, nên không rò rỉ thông tin.

> Đây là chi tiết nhỏ nhưng cho thấy tư duy bảo mật chín: không chỉ "đúng/sai", mà còn "có rò rỉ thông
> tin qua kênh phụ (side-channel) không?".

---

## 4. Bức tranh tổng thể của `confirmPayment`

Hàm `confirmPayment` (`src/reservation-service.ts:202`) đặt các tầng phòng thủ theo đúng thứ tự ưu tiên:

```
(a) Chữ ký hợp lệ?   ──không──▶ ném BAD_SIGNATURE (Bài 4)
        │ có
(b) Đã xử lý rồi?    ──rồi────▶ trả kết quả cũ, replayed=true (Bài 4 - idempotency)
        │ chưa
    payment.failed? ──phải───▶ đánh dấu FAILED, để hold tự hết hạn (Bài 3)
        │ không (là success)
(c) Hold còn hợp lệ? ──không──▶ refund (Bài 3 - compensation)
        │ còn
    Ghi Reservation (UNIQUE backstop - Bài 1) → đánh dấu SUCCEEDED
```

Hãy chiêm nghiệm thứ tự này: **xác thực → chống lặp → xử lý nghiệp vụ**. Bài học: việc kiểm tra rẻ và
mang tính an toàn nên đặt **trước**; việc tốn kém và thay đổi dữ liệu đặt **sau**.

---

## 5. Test chứng minh

**Test #5 — webhook trùng là idempotent: một reservation, trừ tiền một lần** (`reservation.test.ts:87`):

```ts
const first  = await app.reservations.confirmPayment(event);
const replay = await app.reservations.confirmPayment(event); // nhà cung cấp gửi lại

assert.equal(replay.replayed, true);
assert.equal(replay.reservation!.id, first.reservation!.id);          // vẫn đúng reservation cũ
const forSeat = (await app.store.allReservations()).filter((r) => r.seatId === SEAT);
assert.equal(forSeat.length, 1);                                       // KHÔNG tạo cái thứ hai
```

**Test #12 — webhook chữ ký giả bị từ chối** (`reservation.test.ts:186`):

```ts
const forged = { ...event, signature: 'deadbeef' };  // chữ ký bịa
await assert.rejects(() => app.reservations.confirmPayment(forged), code('BAD_SIGNATURE'));
```

---

## 6. Bài tập & câu hỏi thảo luận

1. Cho một ví dụ đời thường về thao tác **idempotent** và một ví dụ **không idempotent** (khác các ví
   dụ trong bài). Vì sao "tạo đơn hàng" thường *không* idempotent nếu không có idempotency key?
2. `idempotencyKey` ở đây ghép từ `userId : seatId : heldUntil`. Vì sao lại có `heldUntil` trong đó?
   Nếu bỏ `heldUntil` đi, điều gì có thể sai khi cùng một người giữ lại ghế đó ở một phiên sau?
3. Giải thích bằng lời: vì sao chữ ký HMAC chứng minh được "request đến từ nhà cung cấp" mà *không*
   cần giấu nội dung sự kiện đi? (Gợi ý: bí mật nằm ở đâu?)
4. **Timing attack:** giải thích vì sao `a === b` trên chuỗi bí mật lại rò rỉ thông tin, còn
   `timingSafeEqual` thì không. Trong những loại so sánh nào khác bạn cũng nên cẩn thận điều này?
5. **Phá để hiểu:** trong `confirmPayment`, thử chuyển bước kiểm tra chữ ký (a) xuống *sau* bước
   idempotency (b). Theo bạn điều này tạo ra lỗ hổng gì? (Gợi ý: kẻ tấn công gửi event giả với một
   key đã từng thành công.)

---

← [Bài 3](./03-payment-consistency.md) · [Mục lục](./README.md) · ➡️ [Bài 5 — Đăng nhập, session & quyền sở hữu](./05-auth-security.md)
