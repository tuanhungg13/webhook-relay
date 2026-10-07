/**
 * Viết một giá trị JSON thành chuỗi chuẩn hóa theo RFC 8785 (JCS): cùng nghĩa thì cùng chuỗi,
 * bất kể App gửi key theo thứ tự nào hay viết số `1.0` hay `1` (ING-03.1).
 *
 * Vì sao tự viết được: RFC 8785 định nghĩa số và chuỗi theo `JSON.stringify` của ECMAScript,
 * nên chỉ còn việc sắp key. `sort()` mặc định so theo UTF-16 code unit, đúng RFC §3.2.3.
 *
 * Đầu vào phải là kết quả của `JSON.parse` đã qua `checkEventPayload`: không có `undefined`,
 * hàm hay số không hữu hạn.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const members = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}
