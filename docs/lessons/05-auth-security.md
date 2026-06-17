# Bài 5 — Đăng nhập, session 90 ngày & quyền sở hữu

← [Bài 4](./04-webhook-idempotency.md) · [Mục lục](./README.md) · ➡️ [Bài 6 — Testability & trade-off](./06-testability-tradeoffs.md)

## Mục tiêu

- Phân biệt **authentication** (bạn là ai) và **authorization** (bạn được phép làm gì).
- Hiểu **session** server-side, và vì sao "có thể thu hồi" (revocable) lại quan trọng với session dài 90 ngày.
- Hiểu lỗ hổng **IDOR** và cách **ownership check** (kiểm tra quyền sở hữu) chặn nó.
- Thấy được sự khác nhau giữa session server-side và **JWT** (một trade-off kinh điển).

---

## 1. Câu chuyện đời thường

Vào một tòa nhà văn phòng:

- **Authentication (xác thực — bạn là ai):** bảo vệ kiểm tra thẻ nhân viên ở cửa → "à, đây là anh Tuấn".
- **Authorization (phân quyền — bạn được làm gì):** thẻ của anh Tuấn mở được tầng 3 (phòng anh ấy),
  nhưng *không* mở được phòng server tầng 5.

Hai việc này khác nhau và **đều cần thiết**. Nhiều lỗ hổng bảo mật nghiêm trọng đến từ chỗ: hệ thống
xác thực đúng (biết bạn là ai) nhưng **quên phân quyền** (không kiểm tra bạn có được đụng vào *thứ
này* không).

---

## 2. Authentication: đăng nhập & session

Yêu cầu nghiệp vụ: "đăng nhập, session hết hạn sau **90 ngày**". Dự án chọn **session server-side**:
khi đăng nhập, tạo một bản ghi session (token + thời điểm hết hạn) lưu trong store
(`src/auth-service.ts:33`):

```ts
async login(email: string): Promise<{ user: User; session: Session }> {
  let user = await this.store.findUserByEmail(email);
  if (!user) { /* tạo user mới */ }

  const now = this.clock.now();
  const session = new Session({
    token: this.idGen('sess'),
    userId: user.id,
    createdAt: now,
    expiresAt: now + this.sessionTtlMs,   // 90 ngày
  });
  await this.store.putSession(session);
  return { user, session };
}
```

Mỗi request sau đó được kiểm tra qua `authenticate` (`src/auth-service.ts:52`):

```ts
async authenticate(token: string | null | undefined): Promise<Session | null> {
  if (!token) return null;
  const session = await this.store.getSession(token);
  if (!session) return null;
  if (!session.isValidAt(this.clock.now())) return null;   // hết 90 ngày → coi như chưa đăng nhập
  return session;
}
```

> Đăng nhập ở đây cố tình **đơn giản** (passwordless — chỉ hỏi "bạn là ai"). Cơ chế đăng nhập thật
> (mật khẩu, magic link, OAuth) là *chi tiết tích hợp*, không phải phần lõi nghiệp vụ mà dự án muốn
> chứng minh. Đây là một quyết định **cắt phạm vi** (scope) có chủ đích — xem Bài 6.

---

## 3. Vì sao chọn session server-side thay vì JWT?

Đây là một **trade-off** rất hay gặp trong phỏng vấn. Hai lựa chọn:

| | Session server-side (dự án chọn) | JWT (token tự chứa) |
|---|---|---|
| Lưu ở đâu | Trong store của server | Không lưu — thông tin nằm trong chính token |
| Kiểm tra hết hạn | Tra store mỗi request | Đọc trường `exp` trong token |
| **Thu hồi (revoke) ngay được không?** | **Được** — xóa bản ghi là xong | **Khó** — token vẫn hợp lệ tới khi tự hết hạn |
| Chi phí | Mỗi request phải tra store | Không cần tra store (stateless) |

Vì session ở đây dài tới **90 ngày**, khả năng **thu hồi tức thì** rất quan trọng: nếu token bị lộ
hoặc người dùng bấm "đăng xuất khỏi mọi thiết bị", ta phải vô hiệu hóa nó *ngay*, không thể chờ 90
ngày. Đó là lý do `logout` xóa hẳn session (`src/auth-service.ts:61`):

```ts
async logout(token: string): Promise<void> {
  await this.store.deleteSession(token);   // thu hồi tức thì — lý do ta giữ session ở server
}
```

> JWT đánh đổi *khả năng thu hồi* để lấy *tính stateless* (không cần tra store). Không có lựa chọn nào
> "đúng tuyệt đối" — tùy bài toán. Với session 90 ngày + liên quan tới tiền, revocable thắng thế.

Và mọi hành động nghiệp vụ đều bắt buộc đăng nhập qua một "cổng" chung `_requireSession`
(`src/reservation-service.ts:77`) — không hàm nào (hold, pay, cancel) bỏ qua được:

```ts
private async _requireSession(token): Promise<Session> {
  const session = await this.auth.authenticate(token);
  if (!session) throw new ReservationError('UNAUTHENTICATED', 'Login required or session expired');
  return session;
}
```

---

## 4. Authorization & lỗ hổng IDOR

> **IDOR (Insecure Direct Object Reference):** lỗ hổng khi người dùng A có thể thao tác lên tài nguyên
> của người dùng B chỉ bằng cách "đoán/đổi id". Ví dụ kinh điển: đổi URL `/invoice/123` thành
> `/invoice/124` để xem hóa đơn của người khác. Nguyên nhân: hệ thống xác thực bạn là ai nhưng **quên
> kiểm tra tài nguyên đó có phải của bạn không**.

Trong dự án, *biết bạn đã đăng nhập là chưa đủ* — bạn còn phải **sở hữu** chỗ giữ ghế đó. Xem các
ownership check:

`cancelHold` (`src/reservation-service.ts:140`):

```ts
if (seat.heldBy !== session.userId) {
  throw new ReservationError('FORBIDDEN', 'Not your hold'); // ownership — chống IDOR
}
```

`pay` (`src/reservation-service.ts:163`):

```ts
if (seat.status !== SeatStatus.HELD || seat.heldBy !== session.userId) {
  throw new ReservationError('NOT_HELD_BY_YOU', 'You must hold the seat before paying'); // ownership
}
```

👉 **Bài học thiết kế:** với *mỗi* hành động lên một tài nguyên, hãy hỏi hai câu **tách biệt**: (1)
"Người này đã đăng nhập chưa?" (authN) và (2) "Tài nguyên này có thuộc về họ không?" (authZ). Quên câu
(2) là nguồn gốc của rất nhiều vụ rò rỉ dữ liệu ngoài đời thực.

---

## 5. Test chứng minh

**Test #8 — bắt buộc đăng nhập & enforce đúng mốc 90 ngày** (`reservation.test.ts:137`):

```ts
await assert.rejects(() => app.reservations.holdSeat('bogus-token', SEAT), code('UNAUTHENTICATED'));

const session = await loginAs(app, 'a@x.com');
app.clock.advance(NINETY_DAYS_MS - 1);  // còn trong hạn 1ms
assert.ok(await app.auth.authenticate(session.token));     // vẫn hợp lệ

app.clock.advance(2);                    // vừa quá 90 ngày
assert.equal(await app.auth.authenticate(session.token), null);  // hết hạn
```

> Lại là sức mạnh của đồng hồ tiêm vào: test "tua" qua đúng ranh giới 90 ngày trong tích tắc, kiểm
> tra cả hai phía của lằn ranh — điều không thể làm nếu code gọi `Date.now()` trực tiếp.

**Test #9 — ownership: B không đụng được hold của A (chống IDOR)** (`reservation.test.ts:153`):

```ts
await app.reservations.holdSeat(a.token, SEAT);
await assert.rejects(() => app.reservations.cancelHold(b.token, SEAT), code('FORBIDDEN'));
await assert.rejects(() => app.reservations.pay(b.token, SEAT, 'success'), code('NOT_HELD_BY_YOU'));
```

---

## 6. Bài tập & câu hỏi thảo luận

1. Phân biệt authentication và authorization bằng một ví dụ *của riêng bạn* (không phải tòa nhà văn
   phòng). Một hệ thống làm đúng cái nào mà thiếu cái kia thì hậu quả ra sao?
2. Liệt kê các tình huống mà khả năng **thu hồi session tức thì** là tối quan trọng. Với mỗi tình
   huống, JWT thuần sẽ xử lý vụng về như thế nào?
3. **Tìm lỗ hổng:** giả sử một lập trình viên mới xóa dòng `if (seat.heldBy !== session.userId)` trong
   `cancelHold`. Hãy mô tả *chính xác* một kẻ tấn công sẽ lạm dụng điều này thế nào. Test nào sẽ bắt
   được lỗi đó?
4. Mốc 90 ngày được enforce bằng `now < expiresAt`. Vì sao điều này *chỉ* test được dễ dàng khi thời
   gian là một input được tiêm vào? (Đây là cầu nối sang Bài 6.)
5. **Mở rộng:** dự án hiện chỉ có một loại người dùng. Nếu thêm vai trò "admin" được phép hủy hold của
   bất kỳ ai, bạn sẽ sửa các ownership check ở mục 4 như thế nào để vừa cho admin qua vừa không mở
   toang IDOR cho người thường?

---

← [Bài 4](./04-webhook-idempotency.md) · [Mục lục](./README.md) · ➡️ [Bài 6 — Làm sao chứng minh hệ thống đúng?](./06-testability-tradeoffs.md)
