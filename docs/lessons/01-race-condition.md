# Bài 1 — Race condition & chống bán trùng ghế

← [Bài 0](./00-tong-quan.md) · [Mục lục](./README.md) · ➡️ [Bài 2 — Hold & TTL](./02-hold-ttl.md)

## Mục tiêu

- Hiểu **race condition** là gì bằng một ví dụ đời thường, rồi nhìn thấy nó *bằng mắt* trong code.
- Hiểu lỗi kinh điển **check-then-act** (kiểm tra rồi mới hành động).
- Hiểu và đọc được kỹ thuật **compare-and-swap (CAS)** dùng để chống bán trùng.
- Hiểu vì sao cần một lớp bảo vệ thứ hai: **unique constraint**.

> Đây là invariant số 1 của dự án: **không bao giờ bán trùng ghế** (no double-booking).

---

## 1. Câu chuyện đời thường

Hai người cùng nhìn vào một lọ kẹo cuối cùng trên bàn.

- An nhìn → "còn 1 viên, mình lấy được!" → vươn tay.
- Bình *cùng lúc* nhìn → "còn 1 viên, mình lấy được!" → vươn tay.

Cả hai đều **kiểm tra (check)** thấy "còn kẹo", rồi cả hai đều **hành động (act)** lấy kẹo. Kết quả:
xung đột — nhưng lọ kẹo chỉ có một viên. Trong phần mềm, "viên kẹo" là chiếc ghế, và kết quả là
**hai người cùng giữ một ghế** = bán trùng.

> **Race condition** (điều kiện tranh chấp): khi kết quả của chương trình phụ thuộc vào *thứ tự/thời
> điểm* các thao tác xảy ra xen kẽ nhau, và một số thứ tự cho ra kết quả **sai**.

Vấn đề cốt lõi tên là **check-then-act**: giữa lúc bạn *kiểm tra* ("ghế còn trống") và lúc bạn *hành
động* ("đánh dấu ghế là của tôi"), một người khác có thể chen vào giữa.

---

## 2. Nhìn thấy con bug — phiên bản "ngây thơ" (naive)

Điều tuyệt vời của dự án này: nó **giữ lại một phiên bản code CỐ TÌNH SAI** để bạn thấy bug, rồi mới
xem phiên bản đúng. Đó là `holdSeatNaive` tại `src/reservation-service.ts:121`:

```ts
async holdSeatNaive(token: string, seatId: string): Promise<Seat> {
  const session = await this._requireSession(token);
  const now = this.clock.now();

  const seat = await this.store.getSeat(seatId);                 // (1) ĐỌC: "ghế còn trống?"
  if (!seat || !seat.isClaimableAt(now)) throw new ReservationError('SEAT_TAKEN', 'Seat taken');

  seat.status = SeatStatus.HELD;                                 // ...thời gian trôi qua...
  seat.heldBy = session.userId;
  seat.heldUntil = now + this.holdTtlMs;
  await this.store.putSeat(seat);                                // (2) GHI ĐÈ mù quáng
  return seat;
}
```

Hãy mổ xẻ kịch bản hai người (An và Bình) chạy hàm này gần như cùng lúc:

| Thời điểm | An | Bình |
|---|---|---|
| t1 | đọc ghế → thấy **AVAILABLE** ✅ | |
| t2 | | đọc ghế → cũng thấy **AVAILABLE** ✅ (vì An chưa ghi xong!) |
| t3 | ghi "ghế của An" | |
| t4 | | ghi "ghế của Bình" → **đè lên** An |

Cả hai đều "thành công". Hệ thống tin rằng cả An và Bình đều đang giữ ghế đó. **Bán trùng.**

> Chỗ chữ "...thời gian trôi qua..." là then chốt. Giữa lúc *đọc* và lúc *ghi*, chương trình có thể
> tạm nhường CPU cho việc khác (mỗi `await` là một điểm nhường). Đó là khe hở để người khác chen vào.

---

## 3. Phiên bản đúng — Compare-and-Swap (CAS)

Ý tưởng sửa lỗi rất tự nhiên: *"Tôi sẽ chỉ ghi nếu ghế vẫn còn y như lúc tôi đọc nó. Nếu ai đó đã đổi
nó rồi, tôi thua cuộc và phải thử lại."*

Để biết "ghế có còn y như lúc tôi đọc không", mỗi ghế mang một con số gọi là **version** — cứ mỗi lần
ghi thành công, version tăng 1. Đây gọi là **optimistic locking** (optimistic concurrency control — cơ
chế khóa lạc quan: cứ làm, đến lúc ghi mới kiểm tra xung đột).

Xem `holdSeat` (phiên bản đúng) tại `src/reservation-service.ts:87`:

```ts
async holdSeat(token: string, seatId: string): Promise<Seat> {
  const session = await this._requireSession(token);
  const now = this.clock.now();

  // (Quy tắc công bằng: mỗi người chỉ giữ 1 ghế — xem Bài 2)
  const existingHold = await this.store.findActiveHoldForUser(session.userId, now);
  if (existingHold) { /* ... */ }

  const seat = await this.store.getSeat(seatId);
  if (!seat) throw new ReservationError('NO_SUCH_SEAT', 'No such seat');
  if (!seat.isClaimableAt(now)) throw new ReservationError('SEAT_TAKEN', '...');

  const expectedVersion = seat.version;          // (1) nhớ version lúc đọc
  seat.status = SeatStatus.HELD;
  seat.heldBy = session.userId;
  seat.heldUntil = now + this.holdTtlMs;

  const won = await this.store.compareAndSwapSeat(seat, expectedVersion);  // (2) ghi CÓ ĐIỀU KIỆN
  if (!won) throw new ReservationError('SEAT_TAKEN', 'Lost the race for this seat');
  return seat;
}
```

Mấu chốt nằm ở `compareAndSwapSeat` trong `src/store.ts:70`:

```ts
async compareAndSwapSeat(next: Seat, expectedVersion: number): Promise<boolean> {
  await this._io();
  const current = this._seats.get(next.id);
  if (!current || current.version !== expectedVersion) return false;  // version đã đổi → THUA
  const stored = next.clone();
  stored.version = expectedVersion + 1;                               // ghi & tăng version
  this._seats.set(stored.id, stored);
  return true;
}
```

Quay lại kịch bản An & Bình, lần này với CAS:

| Thời điểm | An (đọc version = 0) | Bình (đọc version = 0) |
|---|---|---|
| t3 | CAS: version hiện tại **= 0**? ✅ → ghi, version thành **1**, **THẮNG** | |
| t4 | | CAS: version hiện tại **= 0**? ❌ (giờ là 1) → **THUA**, ném `SEAT_TAKEN` |

Đúng **một** người thắng. Bình nhận lỗi rõ ràng thay vì âm thầm "cướp" ghế.

### Vì sao đoạn CAS này an toàn? (điểm cực kỳ quan trọng)

Đọc comment trong `src/store.ts:8`. Mấu chốt: trong `compareAndSwapSeat`, phần **đọc-so sánh-ghi
KHÔNG có lệnh `await` nào xen vào giữa**. Lệnh `await this._io()` (giả lập độ trễ) nằm *trước* đoạn đó.

> **Critical section** (vùng tới hạn): một đoạn code phải chạy "một mạch", không bị ngắt giữa chừng.
> Trong môi trường một luồng như Node.js, code chỉ bị nhường CPU tại các điểm `await`. Vì đoạn so
> sánh-rồi-ghi không có `await`, nó chạy nguyên khối → hai người không thể "chen" vào giữa.

👉 **Bài tập tư duy:** nếu ai đó vô tình thêm `await` vào giữa đoạn so sánh và đoạn ghi, critical
section bị vỡ và bug bán trùng quay lại. Đây là một lỗi *cực kỳ* dễ mắc và khó phát hiện ngoài đời.

---

## 4. Lớp bảo vệ thứ hai: Unique Constraint

CAS rất tốt, nhưng nếu logic ứng dụng có bug khác thì sao? Một kỹ sư giỏi luôn có **phương án dự
phòng** (defense in depth — phòng thủ nhiều lớp).

Lớp thứ hai: ở bước cuối cùng (tạo bản ghi `Reservation`), database từ chối **bản ghi thứ hai cho
cùng một ghế**. Xem `createReservation` tại `src/store.ts:106`:

```ts
async createReservation(reservation: Reservation): Promise<Reservation> {
  await this._io();
  if (this._reservationBySeat.has(reservation.seatId)) {
    throw new Error('SEAT_ALREADY_RESERVED'); // vi phạm UNIQUE(seat_id)
  }
  // ...
}
```

> **Unique constraint** (ràng buộc duy nhất): một quy tắc ở tầng database nói "cột này không được
> trùng". Ở đây: mỗi `seat_id` chỉ được có **một** reservation. Đây là tuyến phòng thủ *cuối cùng*
> chống bán trùng — kể cả khi mọi logic phía trên đều sai, database vẫn chặn.

So sánh hai lớp:

| Lớp | Cơ chế | Chống được gì |
|---|---|---|
| Lớp 1 (chủ động) | compare-and-swap trên `version` | Hai người cùng *giữ chỗ* một ghế |
| Lớp 2 (dự phòng) | `UNIQUE(seat_id)` trên reservation | Hai người cùng *đặt thành công* một ghế |

---

## 5. Test chứng minh

Trong `test/reservation.test.ts`, hai test sau là "linh hồn" của bài này. Hãy chạy `node --test` và
quan sát:

**Test #2 — phiên bản đúng: đúng một người thắng** (`reservation.test.ts:43`):

```ts
const results = await Promise.allSettled([
  app.reservations.holdSeat(a.token, SEAT),
  app.reservations.holdSeat(b.token, SEAT),
]);
const winners = results.filter((r) => r.status === 'fulfilled');
assert.equal(winners.length, 1, 'exactly one buyer may hold the seat');
```

**Test #3 — phiên bản naive: BUG bán trùng tái hiện** (`reservation.test.ts:58`):

```ts
const results = await Promise.allSettled([
  app.reservations.holdSeatNaive(a.token, SEAT),
  app.reservations.holdSeatNaive(b.token, SEAT),
]);
const winners = results.filter((r) => r.status === 'fulfilled');
assert.equal(winners.length, 2, 'the naive version wrongly lets BOTH hold the same seat');
```

> Chú ý chi tiết tinh tế: cả hai test đều tạo app với `latencyMs: 5`. Độ trễ giả lập này *ép* hai
> lời gọi thực sự xen kẽ nhau ở event loop — biến race condition từ "lý thuyết" thành "tái hiện được
> 100%". Không có nó, hai thao tác có thể tình cờ chạy nối tiếp và bug không lộ ra. (Xem comment
> `src/store.ts:19`.)

Test #10 (`reservation.test.ts:164`) kiểm tra lớp phòng thủ thứ hai: một ghế đã RESERVED thì không
ai giữ lại được nữa.

---

## 6. Liên hệ thực tế (production)

Dự án dùng store trong bộ nhớ, nhưng *logic* y hệt sản phẩm thật:

| Trong dự án | Ngoài production (ví dụ Postgres) |
|---|---|
| `compareAndSwapSeat(seat, version)` — optimistic locking | `UPDATE seats SET ... WHERE id = ? AND version = ?` (kiểm tra số dòng bị ảnh hưởng) |
| Critical section không `await` | `SELECT ... FOR UPDATE` (pessimistic locking — khóa dòng), hoặc transaction |
| `throw 'SEAT_ALREADY_RESERVED'` | Database ném lỗi vi phạm `UNIQUE(seat_id)` |

👉 **Bài học thiết kế:** chọn đúng *invariant* (đúng một người thắng) thì việc đổi từ in-memory sang
Postgres chỉ là thay phần lưu trữ — phần logic nghiệp vụ không đổi. Đây là sức mạnh của việc tách bạch.

---

## 7. Bài tập & câu hỏi thảo luận

1. **Phá để hiểu:** mở `src/store.ts`, trong `compareAndSwapSeat`, thử thêm một dòng
   `await this._io();` vào *giữa* phần đọc `current` và phần ghi `this._seats.set(...)`. Chạy lại
   `node --test`. Test #2 còn xanh không? Giải thích.
2. Trong `holdSeatNaive`, đường đi tới bug là check-then-act. Hãy chỉ ra *chính xác* dòng nào là
   "check" và dòng nào là "act", và khe hở nằm ở đâu.
3. Phiên bản CAS dùng **optimistic locking** (cứ làm, đụng độ thì thua & báo lỗi). Một cách khác là
   **pessimistic locking** (khóa ghế lại trước khi ai khác đụng vào, ví dụ `SELECT ... FOR UPDATE`).
   Nêu một ưu và một nhược của mỗi cách.
4. Vì sao có CAS rồi mà vẫn cần `UNIQUE(seat_id)`? Hãy nghĩ ra một kịch bản (dù hiếm) mà lớp 1 không
   đủ và lớp 2 cứu nguy. (Gợi ý: bug trong code, hoặc chạy nhiều server cùng lúc.)

---

← [Bài 0](./00-tong-quan.md) · [Mục lục](./README.md) · ➡️ [Bài 2 — Hold, TTL & khách bỏ giỏ hàng](./02-hold-ttl.md)
