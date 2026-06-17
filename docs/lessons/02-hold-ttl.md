# Bài 2 — Giữ chỗ tạm (hold), TTL & khách bỏ giỏ hàng

← [Bài 1](./01-race-condition.md) · [Mục lục](./README.md) · ➡️ [Bài 3 — Tiền & hàng](./03-payment-consistency.md)

## Mục tiêu

- Hiểu vì sao cần một trạng thái **HELD** (giữ tạm) nằm giữa "trống" và "đã đặt".
- Hiểu **TTL** (time-to-live) và cách dùng nó để xử lý khách hàng bỏ ngang.
- Hiểu kỹ thuật **lazy expiry** (hết hạn kiểu lười) và vì sao nó *tự đúng* mà không cần job chạy nền.
- Hiểu một quy tắc **công bằng** (fairness): mỗi người giữ tối đa N ghế (per-user hold cap).

> Đây là invariant số 3: **giỏ hàng bị bỏ quên phải tự phục hồi** (abandoned checkouts self-heal).

---

## 1. Câu chuyện đời thường

Bạn vào shop online, bỏ đôi giày cuối cùng vào giỏ, rồi... đi ăn cơm, quên luôn. Câu hỏi: đôi giày đó
nên bị khóa cho bạn **mãi mãi** không?

- Nếu **có** → người thực sự muốn mua không mua được, shop mất doanh thu, kho "kẹt hàng ảo".
- Nếu **không** → cần một quy tắc: "giữ cho bạn trong X phút; quá giờ mà chưa trả tiền thì thả ra".

Đó chính xác là vai trò của trạng thái **HELD** + **TTL**. Giữ ghế đủ lâu để khách kịp trả tiền, nhưng
không lâu đến mức một người lơ đãng làm "đóng băng" cả kho ghế.

---

## 2. TTL là gì, và nó sống ở đâu trong code?

> **TTL (time-to-live)**: khoảng thời gian một thứ còn "sống/hiệu lực". Hết TTL, nó coi như không còn.

Khi giữ ghế, hệ thống gắn cho ghế một mốc `heldUntil` = "giữ đến thời điểm này". Mặc định TTL là **5
phút** (`src/reservation-service.ts:8`):

```ts
const DEFAULT_HOLD_TTL_MS = 5 * 60 * 1000; // 5 phút để trả tiền trước khi ghế được thả
```

Khi giữ ghế (`src/reservation-service.ts:108`):

```ts
seat.heldUntil = now + this.holdTtlMs;   // "giữ đến: bây giờ + 5 phút"
```

---

## 3. Lazy expiry — "hết hạn kiểu lười"

Có hai cách để xử lý một chỗ giữ đã quá hạn:

- **Cách chủ động (eager):** chạy một job nền cứ vài giây quét toàn bộ ghế, thấy cái nào quá hạn thì
  thả ra. Nhược: phải có hạ tầng job, và giữa hai lần quét vẫn có khoảng "ghế đã hết hạn nhưng chưa
  được thả".
- **Cách lười (lazy):** *không* dọn ngay. Thay vào đó, **mỗi khi có người muốn giành ghế**, ta mới
  hỏi "tại thời điểm bây giờ, ghế này có giành được không?" — và một chỗ giữ đã quá hạn sẽ tự động
  được tính là "giành được".

Dự án chọn **lazy expiry**, và nó nằm gọn trong `Seat.isClaimableAt` mà bạn đã gặp ở Bài 0
(`src/domain.ts:56`):

```ts
isClaimableAt(now: number): boolean {
  if (this.status === SeatStatus.AVAILABLE) return true;
  if (this.status === SeatStatus.HELD && this.heldUntil !== null && this.heldUntil <= now) return true; // ← đây
  return false;
}
```

Dòng giữa chính là lazy expiry: *"ghế đang HELD nhưng `heldUntil` đã ở quá khứ → coi như trống."* Ghế
**không cần** được ai đó đổi cờ thành `AVAILABLE` trước; nó được tính là trống *ngay tại thời điểm
được hỏi*.

👉 **Bài học thiết kế:** lazy expiry **đúng đắn về mặt logic mà không cần job nền nào cả**. Đây là một
ý tưởng rất đẹp: thay vì "dọn dẹp trạng thái cho khớp thực tế", ta "diễn giải trạng thái dựa trên thời
gian hiện tại". Ít hạ tầng hơn, ít thứ hỏng hơn.

---

## 4. Vậy còn cái job dọn dẹp (sweeper) thì sao?

Dự án *vẫn có* một hàm dọn dẹp `releaseExpiredHolds` (`src/reservation-service.ts:284`), nhưng hãy đọc
kỹ comment ngay trên nó (`src/reservation-service.ts:279`):

> *"Lazy expiry already guarantees correctness; this just tidies state (and is where a production cron
> / queue would hook in)."*

Nghĩa là: tính **đúng đắn** đã được lazy expiry lo. Sweeper chỉ để **dọn cho gọn** (đổi cờ ghế quá hạn
về `AVAILABLE` thật sự), ví dụ để màn hình hiển thị "còn ghế trống" cập nhật mà không cần ai bấm vào.
Và đây là chỗ mà ngoài production bạn sẽ cắm một **cron job** hay **message queue** vào.

```ts
async releaseExpiredHolds(): Promise<number> {
  const now = this.clock.now();
  let released = 0;
  for (const seat of await this.store.allSeats()) {
    if (seat.status === SeatStatus.HELD && seat.heldUntil !== null && seat.heldUntil <= now) {
      const expectedVersion = seat.version;
      seat.status = SeatStatus.AVAILABLE;
      // ...
      if (await this.store.compareAndSwapSeat(seat, expectedVersion)) released += 1;  // vẫn dùng CAS!
    }
  }
  return released;
}
```

Chú ý: sweeper vẫn dùng **compare-and-swap** (Bài 1) khi thả ghế, vì *ngay cả lúc dọn dẹp* cũng có thể
có người khác đang thao tác trên ghế đó. Tư duy phòng thủ này nhất quán xuyên suốt dự án.

---

## 5. Quy tắc công bằng: mỗi người tối đa N ghế (per-user hold cap)

Một loại "tấn công"/lạm dụng đời thực: một người giữ *tất cả* các ghế để người khác không mua được
(đầu cơ, hoặc vô tình do bug client gọi nhiều lần). Nhưng nếu chặn cứng **mỗi người chỉ 1 ghế** thì
lại sai với thực tế: ngoài đời một người thường đặt **vài ghế cho cả nhóm/gia đình**. Vì vậy dự án
dùng một **hạn mức mỗi người (per-user hold cap)** — giữ tối đa `N` ghế đang hiệu lực, mặc định `6` —
đủ để đặt theo nhóm nhưng vẫn chặn việc ôm hết kho (`src/reservation-service.ts:93`):

```ts
const activeHolds = await this.store.findActiveHoldsForUser(session.userId, now);
const alreadyHeld = activeHolds.find((held) => held.id === seatId);
if (alreadyHeld) return alreadyHeld;   // chọn lại đúng ghế mình đang giữ → không sao (idempotent)
if (activeHolds.length >= this.maxSeatsPerUser) {
  throw new ReservationError('HOLD_LIMIT_REACHED', `You may hold at most ${this.maxSeatsPerUser} seats at a time`);
}
```

Chi tiết tinh tế đáng khen: nếu bạn chọn lại **đúng cái ghế bạn đang giữ**, hệ thống trả về bình
thường thay vì báo lỗi (và **không** tính thêm vào hạn mức). Đây là tính **idempotent** (làm lại nhiều
lần cũng cho cùng kết quả) — ta sẽ gặp lại khái niệm này ở Bài 4.

> Lưu ý `findActiveHoldsForUser` (`src/store.ts:94`) chỉ tính hold **còn hiệu lực** (`heldUntil > now`).
> Tức là một hold đã hết hạn thì không bị tính — bạn vẫn được giữ ghế mới. Lại là lazy expiry.
>
> `N` được tiêm vào qua `maxSeatsPerUser` (mặc định 6) nên mỗi sự kiện có thể chỉnh hạn mức riêng mà
> không sửa logic.

---

## 6. Test chứng minh

**Test #4 — hold hết hạn thì ghế giành lại được** (`reservation.test.ts:73`):

```ts
await app.reservations.holdSeat(a.token, SEAT);
await assert.rejects(() => app.reservations.holdSeat(b.token, SEAT), code('SEAT_TAKEN')); // B chưa giành được

app.clock.advance(60_001); // ⏩ tua thời gian: hold của A hết hạn
const seat = await app.reservations.holdSeat(b.token, SEAT);  // giờ B giành được
assert.equal(seat.heldBy, (await app.store.findUserByEmail('b@x.com'))!.id);
```

> Để ý `app.clock.advance(60_001)` — test không hề `sleep` chờ 1 phút thật. Nó "tua nhanh" một đồng
> hồ giả. Vì sao làm được điều này? Vì thời gian được *tiêm vào* hệ thống chứ không gọi `Date.now()`
> bừa bãi. Đây là chủ đề của [Bài 6](./06-testability-tradeoffs.md).

**Test #11 — giữ tới hạn mức thì được, quá thì bị chặn** (`reservation.test.ts:177`):

```ts
const app = await appWith({ seatCount: 4, maxSeatsPerUser: 2 });
// ...
await app.reservations.holdSeat(a.token, 'seat_A1');
await app.reservations.holdSeat(a.token, 'seat_A2');           // vẫn trong hạn mức → OK (đặt cho nhóm)
await app.reservations.holdSeat(a.token, 'seat_A1');           // chọn lại ghế cũ → idempotent, không tính thêm
await assert.rejects(() => app.reservations.holdSeat(a.token, 'seat_A3'), code('HOLD_LIMIT_REACHED')); // quá hạn mức
```

---

## 7. Bài tập & câu hỏi thảo luận

1. Giải thích bằng lời của bạn: vì sao **lazy expiry không cần job nền** mà vẫn đảm bảo không ai giành
   được ghế của người khi hold còn hiệu lực, đồng thời ghế hết hạn lại giành được ngay?
2. Nếu chọn TTL **quá ngắn** (ví dụ 10 giây) thì trải nghiệm khách hàng ra sao? Nếu **quá dài** (ví dụ
   2 giờ) thì kho ghế ra sao? TTL là một **trade-off** — hãy nêu các yếu tố bạn cân nhắc để chọn con số.
3. Sweeper `releaseExpiredHolds` "không bắt buộc cho tính đúng đắn". Vậy *khi nào* bạn thật sự cần nó
   trong production? (Gợi ý: nghĩ về cái mà người dùng *nhìn thấy* trên màn hình danh sách ghế.)
4. **Phá để hiểu:** trong `findActiveHoldsForUser` (`src/store.ts:94`), thử bỏ điều kiện
   `seat.heldUntil > now`. Theo bạn test nào sẽ hỏng, và vì sao? Chạy `node --test` để kiểm chứng.
5. Hạn mức `N` nên đặt bằng bao nhiêu? Nêu rủi ro nếu để **quá cao** (gần như không giới hạn) và nếu
   để **quá thấp** (ví dụ 1). Vì sao đặt `N` thành **tham số tiêm vào** lại tốt hơn hard-code?

---

← [Bài 1](./01-race-condition.md) · [Mục lục](./README.md) · ➡️ [Bài 3 — Tiền và hàng không được lệch nhau](./03-payment-consistency.md)
