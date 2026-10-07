/**
 * `customer_id`: 1–128 ký tự gồm chữ, số và `. _ : -` (spec 05, gửi sự kiện).
 * Dùng chung cho sự kiện và endpoint để một luật chỉ nằm một chỗ.
 */
export const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Số ký tự tối đa của một loại sự kiện (`type`). */
export const EVENT_TYPE_MAX_LENGTH = 128;

/**
 * Một loại sự kiện, vd `order.created`: các đoạn chữ thường/số/gạch dưới nối bằng dấu chấm
 * (spec 05). Regex: một đoạn, rồi lặp lại "dấu chấm + một đoạn" 0 hay nhiều lần. Độ dài tối đa
 * kiểm riêng bằng `EVENT_TYPE_MAX_LENGTH`.
 */
export const EVENT_TYPE_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
