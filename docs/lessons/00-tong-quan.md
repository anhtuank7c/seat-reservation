# Bài 0 — Tổng quan & "máy trạng thái" của một chiếc ghế

← [Quay lại mục lục](./README.md) · ➡️ Bài tiếp theo: [Bài 1 — Race condition](./01-race-condition.md)

## Mục tiêu

Học xong bài này, bạn sẽ:

- Hiểu bài toán nghiệp vụ mà cả khóa học xoay quanh.
- Biết khái niệm **state machine** (máy trạng thái) là gì và vì sao nó cực kỳ hữu ích trong system design.
- Đọc được "bản đồ" của dự án: file nào làm gì.
- Nắm 3 nguyên tắc (invariants) mà mọi dòng code trong dự án đều phục vụ.

---

## 1. Câu chuyện đời thường

Tưởng tượng bạn đặt vé xem phim. Bạn chọn ghế **A1**, hệ thống "khóa" ghế đó lại cho bạn trong vài
phút để bạn kịp trả tiền. Nếu bạn trả tiền xong → ghế là của bạn. Nếu bạn lơ là quá lâu → ghế được
thả ra cho người khác.

Nghe thì đơn giản. Nhưng hãy hỏi vài câu "khó chịu":

- Nếu **đúng cùng một khoảnh khắc**, hai người cùng bấm chọn ghế A1 thì sao?
- Nếu bạn **đã bị trừ tiền** nhưng đúng lúc đó cái "khóa ghế" vừa hết hạn thì sao?
- Nếu ngân hàng báo "đã trả tiền" tới hệ thống **hai lần** thì sao?
- Nếu có kẻ xấu tự gửi tin nhắn "tôi đã trả tiền" mà thực ra chưa trả thì sao?

Đây chính là **những thử thách mà hệ thống phải đối mặt** (the challenges a system must face). Cả khóa
học này là để trả lời từng câu hỏi đó một cách nghiêm túc.

---

## 2. Bài toán cụ thể trong dự án

Dự án mô phỏng phần lõi của một nền tảng đặt chỗ. Yêu cầu gốc (xem `docs/ASSESSMENT_ANALYSIS.md`) rất
ngắn gọn:

1. Hiển thị **3 ghế** trống.
2. Chỉ **người đã đăng nhập** mới được đặt.
3. **Đăng nhập** có session hết hạn sau **90 ngày**.
4. **Chọn ghế** (giữ chỗ tạm).
5. **Thanh toán**.
6. **Đặt chỗ thành công khi thanh toán hoàn tất**.

Sáu yêu cầu này là phần *dễ*. Phần *khó* — và là lý do dự án tồn tại — nằm ở những câu hỏi "khó chịu"
phía trên: **không bao giờ bán trùng ghế** và **tiền với hàng không bao giờ lệch nhau**.

---

## 3. Khái niệm cốt lõi: State Machine (máy trạng thái)

> **State machine** = một cách mô tả "một thứ gì đó tại mỗi thời điểm chỉ ở **đúng một trạng thái**,
> và chỉ được chuyển trạng thái theo những đường đã định sẵn."

Một chiếc ghế trong hệ thống này luôn ở **đúng một trong ba trạng thái**:

```
                 holdSeat (atomic CAS)            confirmPayment (hold còn hợp lệ)
   AVAILABLE ─────────────────────────▶ HELD ──────────────────────────────▶ RESERVED
       ▲                                 │
       └──── hết hạn TTL / hủy / ────────┘
             thanh toán bị từ chối
```

- **AVAILABLE** — ghế trống, ai cũng có thể giành.
- **HELD** — đang được một người giữ tạm, kèm mốc thời gian `heldUntil` (giữ đến lúc nào).
- **RESERVED** — đã đặt thành công. Đây là trạng thái **terminal** (cuối cùng, không quay lui được).

**Vì sao state machine quan trọng trong system design?**

1. Nó biến những câu mô tả mơ hồ ("ghế đang được xử lý") thành **trạng thái rõ ràng**, không nhập nhằng.
2. Nó liệt kê đầy đủ các **đường chuyển hợp lệ**. Mọi đường *không* có trong sơ đồ đều là **bug** —
   ví dụ: chuyển thẳng từ `AVAILABLE` sang `RESERVED` mà bỏ qua `HELD` là sai (chưa giữ chỗ, chưa trả tiền).
3. Nó cho bạn một danh sách câu hỏi: "Chuyện gì xảy ra ở mỗi trạng thái khi có sự cố?" → chính là các bài học sau.

### Đọc code thật

Ba trạng thái được khai báo tường minh trong `src/domain.ts:10`:

```ts
export const SeatStatus = {
  AVAILABLE: 'AVAILABLE',
  HELD: 'HELD',
  RESERVED: 'RESERVED',
} as const;
```

Câu hỏi quan trọng nhất — *"ghế này có đang được phép giành không?"* — được gói gọn trong **một hàm
duy nhất** `Seat.isClaimableAt(now)` tại `src/domain.ts:56`:

```ts
isClaimableAt(now: number): boolean {
  if (this.status === SeatStatus.AVAILABLE) return true;
  if (this.status === SeatStatus.HELD && this.heldUntil !== null && this.heldUntil <= now) return true;
  return false;
}
```

Đọc bằng tiếng Việt: *"Ghế giành được nếu nó đang trống, HOẶC nó đang bị giữ nhưng cái giữ đó đã hết
hạn. Ghế đã RESERVED thì không bao giờ giành được."*

👉 **Bài học thiết kế:** gom một quy tắc nghiệp vụ quan trọng vào **một chỗ duy nhất** (single source
of truth). Sau này dù logic giữ chỗ hay logic dọn dẹp đều hỏi cùng một câu, chúng gọi cùng một hàm —
không có chuyện hai nơi hiểu "ghế trống" theo hai kiểu khác nhau.

---

## 4. Bản đồ dự án — file nào làm gì

| File | Trách nhiệm |
|---|---|
| `src/domain.ts` | Các thực thể (Seat, Payment...) + quy tắc bất biến (`Seat.isClaimableAt`) |
| `src/store.ts` | Kho lưu trữ trong bộ nhớ — đóng vai database, có **compare-and-set** + **unique constraint** |
| `src/clock.ts` | Đồng hồ — thời gian được "tiêm vào" (inject) để test được |
| `src/payment-gateway.ts` | Cổng thanh toán giả lập — intent idempotent + webhook ký **HMAC** |
| `src/auth-service.ts` | Đăng nhập + session 90 ngày, có thể thu hồi |
| `src/reservation-service.ts` | **Phần lõi**: hold / pay / confirm / cancel / dọn dẹp |
| `src/app.ts` | Lắp ráp tất cả lại với nhau, tạo sẵn 3 ghế |
| `test/reservation.test.ts` | Mỗi quan ngại nghiệp vụ = một test |
| `demo.ts` | Kịch bản kể lại từng bước |

> Đây là một kiến trúc gồm nhiều **class nhỏ, mỗi class một nhiệm vụ** (single responsibility).
> Thời gian và thanh toán được **tiêm vào từ bên ngoài** (dependency injection) — ta sẽ học kỹ ở
> [Bài 6](./06-testability-tradeoffs.md).

---

## 5. Ba nguyên tắc (invariants) chi phối toàn bộ dự án

Một **invariant** là một điều luôn-luôn-đúng mà hệ thống cam kết giữ vững, dù chuyện gì xảy ra. Ba
invariant này được viết ngay trong phần mô tả của `ReservationService` (`src/reservation-service.ts:45`):

1. **Không bao giờ bán trùng ghế** (no double-booking). → [Bài 1](./01-race-condition.md)
2. **Tiền và hàng (inventory) luôn nhất quán** — giữ ghế *trước khi* trừ tiền; nếu trừ tiền rồi mà
   mất ghế thì *hoàn tiền*. → [Bài 3](./03-payment-consistency.md)
3. **Giỏ hàng bị bỏ quên tự phục hồi** — chỗ giữ có hạn (TTL); hết hạn thì coi như trống. → [Bài 2](./02-hold-ttl.md)

Hãy ghi nhớ ba câu này. Mỗi bài học sau chỉ là **đào sâu vào một invariant** và xem code bảo vệ nó như thế nào.

---

## 6. Bài tập & câu hỏi thảo luận

1. **Vẽ lại state machine** của chiếc ghế bằng giấy, rồi ghi cạnh mỗi mũi tên: "sự kiện gì kích hoạt
   chuyển trạng thái này?".
2. Trạng thái `RESERVED` là *terminal*. Theo bạn, đời thực có cần đường đi từ `RESERVED` ngược về
   `AVAILABLE` không (ví dụ: khách trả vé)? Nếu có, nó sẽ làm phát sinh những vấn đề gì mới?
3. Mở `src/domain.ts`, tìm hàm `clone()` xuất hiện ở mọi entity. Đọc comment đầu file và đoán xem
   *vì sao* mọi thứ lấy ra từ store đều là bản sao (clone) chứ không phải tham chiếu gốc. (Gợi ý:
   liên quan tới việc nhiều người cùng thao tác một lúc — ta sẽ gặp lại ở Bài 1.)
4. **Chạy thử:** `cd seat-reservation && node demo.ts`. Quan sát output và đối chiếu từng dòng với
   state machine ở mục 3.

---

← [Mục lục](./README.md) · ➡️ [Bài 1 — Race condition & chống bán trùng ghế](./01-race-condition.md)
