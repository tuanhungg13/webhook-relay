---
name: comment-tieng-viet
description: Quy tắc comment tiếng Việt dễ hiểu cho mã nguồn dự án webhook-relay. Dùng MỖI KHI viết mới hoặc sửa function, method, class, interface, type, hằng số trong src/ hoặc test/ của dự án này, và khi Sếp bảo "comment giúp", "giải thích trong code", "thêm comment".
---

# Comment tiếng Việt dễ hiểu

Người đọc là Sếp, người đang học dự án này. Comment phải giúp Sếp đọc code mà không cần hỏi lại.

## Bắt buộc

1. **Mọi function, method, class, interface, type và hằng số có tên** đều có JSDoc `/** ... */`
   bằng tiếng Việt có dấu, đặt ngay phía trên. Áp dụng cho cả hàm không export.
2. JSDoc của function trả lời theo thứ tự (bỏ ý nào không có):
   - Câu đầu: hàm **làm gì**, viết bằng lời thường.
   - **Vì sao** làm như vậy, nếu không hiển nhiên.
   - Input đặc biệt, kết quả trả về trong từng trường hợp, khi nào **ném lỗi**.
   - Mã yêu cầu trong spec để tra cứu, đặt trong ngoặc: `(SEC-11)`, `(DAT-22)`.
3. Trong thân hàm:
   - Hàm có trình tự nhiều bước thì đánh số bước: `// 1. ...`, `// 2. ...`.
   - Dòng nào khó hiểu thì comment ngay trên dòng đó, hoặc cuối dòng nếu ngắn: SQL, bit,
     BigInt, regex, mẹo, chỗ cố ý làm khác thường.
4. Gặp thuật ngữ lần đầu trong file thì giải thích ngắn gọn ngay tại chỗ, ví dụ:
   hash, UUID, port/adapter, idempotent, BigInt, `$1` trong SQL, `COALESCE`.
5. Tên biến, tên hàm và chuỗi thông báo lỗi giữ tiếng Anh như code hiện có. **Chỉ comment là tiếng Việt.**
6. Sửa code thì **sửa luôn comment** cho khớp. Comment sai còn tệ hơn không có comment.

## Không làm

- Không comment lặp lại đúng điều dòng code đã nói (`i++ // tăng i`). Comment phải nói thêm
  điều mà đọc code không thấy ngay: ý nghĩa, lý do, hệ quả.
- Không viết comment kiểu nhật ký ("sửa ngày...", "thêm bởi..."). Việc đó là của git.
- Không để code chết hay TODO trong comment.

## Ví dụ

```ts
/**
 * Băm key bằng SHA-256. Từ key tính ra hash thì dễ, từ hash không suy ngược ra key được.
 *
 * Cùng một key luôn cho cùng một hash, nên khi App gửi key lên, server chỉ cần băm lại
 * rồi tìm trong database. Dùng hàm băm nhanh là đủ vì key có 256 bit ngẫu nhiên (SEC-11).
 */
export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}
```

## Kiểm tra trước khi báo xong

- Function, class, interface, type, hằng số nào mới hoặc vừa sửa mà chưa có JSDoc tiếng Việt?
- Comment cũ còn khớp với code mới không?
- Chạy `pnpm exec prettier --write` cho file đã sửa, rồi `pnpm typecheck`.
