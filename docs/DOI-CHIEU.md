# Đối chiếu: điều gì đã chứng minh, điều gì đã bác bỏ

Tài liệu này tồn tại vì trong quá trình sửa module chấm phát âm đã có **nhiều
kết luận bị đảo ngược**. Mục đích: tách bạch những gì có bằng chứng khỏi những
gì mới chỉ là giả thuyết, để không ai (kể cả người viết ra nó) phải tin vào trí
nhớ.

**Nguyên tắc:** mọi khẳng định ở mục "Đã chứng minh" đều **chạy lại được**.
Nếu không chạy lại được thì nó thuộc mục "Chưa biết".

---

## Ba nguồn sự thật

Khi có tranh cãi về việc gì đúng, chỉ ba nguồn này có giá trị:

| Câu hỏi thuộc loại | Nguồn | Cách tra |
|---|---|---|
| Mã của iFLYTEK nghĩa là gì? | Tài liệu chính thức | https://global.xfyun.cn/doc/voiceservice/ise/API.html |
| iFLYTEK **thực sự** trả về gì? | XML thô | `npm run dump:xml` → `ise-xml-dump.txt` |
| Code của ta **thực sự** làm gì? | Chạy trên dữ liệu đã lưu | `npm run verify` · `npm run rescore:practice -- --dry` |
| Bản ghi âm có đủ chất lượng không? | Đo tín hiệu | `python3 src/scripts/analyzeAudio.py <file.wav>` |

Suy luận không nằm trong bốn dòng trên thì là **giả thuyết**, không phải kết luận.

---

## Đã chứng minh

Chạy `npm run verify` để kiểm chứng lại toàn bộ mục này.

| # | Khẳng định | Bằng chứng |
|---|---|---|
| 1 | Bộ hạ sample cũ gây aliasing **toàn phần** | Tone 12 kHz → biên độ 1.00 tại 4 kHz sau khi hạ sample. 100% năng lượng gập xuống. |
| 2 | `perr_msg` là **mã phân loại**, không phải thang mức độ | Lấy `max()` làm mất lỗi: 好 có thanh mẫu sai (1) + vận mẫu&thanh điệu sai (3) → bản cũ chỉ báo một. |
| 3 | Phone bắt đầu bằng `_` là **giới âm**, thuộc vận mẫu | XML thật: 卫 `wèi` → `_u`, 样 `yàng` → `_i`, đều mang `is_yun="0"`. Gán nhãn "thanh mẫu" cho âm tiết zero thanh mẫu là bất khả thi. |
| 4 | `check_type=common` tốt hơn `hard` | Cùng một file: `hard` → thanh điệu 78, 2 chữ oan; `common` → 89, 1 chữ. `easy` không hơn `common`. |
| 5 | iFLYTEK **tất định** | Gửi cùng một file 3 lần → kết quả giống hệt. Mọi dao động đến từ khâu thu âm. |
| 6 | `total_score` của iFLYTEK phân biệt tốt hơn công thức cộng 4 tiêu chí | 2 lượt đọc đúng vs 2 lượt đọc sai: cách cũ 96/97 vs 82/84 (cách 12); iFLYTEK 90/95 vs 71/75 (cách 15). |
| 7 | `dp_message` tầng `word` và `serr_msg` **không tồn tại** trong XML thật | Kiểm 3 file XML, `category=read_sentence`, `ent=cn_vip`. Code đọc chúng chỉ là lưới an toàn, không chạy. |
| 8 | Đối chiếu IAT không siết oan bài đọc đúng | 86 lượt đã lưu: 4 lượt bị siết, **0 lượt đọc sạch**. |
| 9 | Tiếng nói dốc mạnh về tần số thấp | Mẫu TTS **sạch** cũng chỉ đạt "95% rolloff" ở 1453 Hz. Mọi ngưỡng tuyệt đối về dải tần phải hiệu chỉnh bằng mẫu chuẩn. |

---

## Đã bác bỏ

Những giả thuyết dưới đây **từng được đưa ra và đã sai**. Ghi lại để không ai
làm lại từ đầu.

| Giả thuyết sai | Bằng chứng bác bỏ |
|---|---|
| "Loa iPhone tước mất F0 nên điểm thanh điệu vô dụng" | Vẫn qua loa iPhone: thanh điệu 100 (đọc đúng) vs 67 (đọc sai). Phân biệt tốt. |
| "Âm tiết thanh nhẹ hay bị chấm oan, cần giảm trọng số" | Xây trên **một** ví dụ. Thống kê: 么 chỉ bị gắn cờ ở lượt đọc kém (55–88), không bao giờ ở lượt đọc chuẩn (90–97). Nó là tín hiệu thật. |
| "Cắt khoảng lặng đầu/cuối sẽ chữa lỗi căn chỉnh" | Đo A/B 3 file: một file **tệ đi rõ** (phát âm 96→89, 1→3 chữ oan). Không ship. Xem `src/lib/audioTrim.js`. |
| "`perr_level_msg=2` nên hiển thị vàng dù không có lỗi" | Tự tạo lỗi mà máy chấm không báo. Một bài `phone_score=100, tone_score=100` vẫn hiện 2 từ vàng + thẻ "Phát âm chưa đúng" điểm 100. |
| "95% rolloff dưới 3500 Hz nghĩa là băng hẹp" | Mẫu TTS sạch cũng chỉ 1453 Hz. Ngưỡng vô nghĩa, gắn cờ đỏ cho mọi file. |
| "98% năng lượng dưới 500 Hz nghĩa là mất dải cao" | Cắt dải dưới 300 Hz thì phổ trở lại gần bình thường. Thực ra là **nhiễu âm trầm** che lấp phép đo. |

---

## Chưa biết

Không có bằng chứng theo hướng nào. **Đừng trình bày như đã kết luận.**

| Câu hỏi để ngỏ | Cần gì để trả lời |
|---|---|
| Bản sửa aliasing có giải quyết phàn nàn gốc của khách hàng không? | Cho khách đọc **trực tiếp vào mic**. Toàn bộ dữ liệu hiện có đều qua loa iPhone — đường đi vốn đã cắt sẵn dải cao nên không thể hiện được tác dụng của bản sửa. |
| Vì sao âm tiết **đầu câu** hay bị gắn cờ oan? | 大 bị gắn cờ ở 3/4 lượt, luôn đứng sau 1,3–1,6 s im lặng. Cắt im lặng đã thử và làm tệ hơn. Chưa có cách chữa. |
| Máy Windows của khách hàng có bật khử ồn của hãng không? | Chạy app trên đúng máy đó rồi mở Lịch sử luyện nói — bảng chẩn đoán hiện trạng thái thật của khử ồn/AGC/khử vọng. |
| `perr_level_msg` chính xác nghĩa là gì? | **Không có trong tài liệu.** Quan sát: 1–3, độc lập với `perr_msg`, có vẻ chấm chất lượng âm đoạn. Chỉ dùng ở mức bổ trợ. |
| Điểm tổng thấp hơn cả 4 tiêu chí thì trình bày thế nào? | Đã thấy: 4 tiêu chí 75·88·83·93 → tổng 72. `total_score` không phải trung bình có trọng số của chúng. Chưa xử lý. |

---

## Cách làm việc rút ra

Phần lớn các lần đảo ngược ở trên có chung một nguyên nhân: **kết luận trước,
đo sau**. Ba thói quen tránh lặp lại:

1. **Giả thuyết dựa trên một ví dụ thì vẫn là một ví dụ.** Cơ chế thanh nhẹ được
   xây từ đúng một chữ, và ví dụ đó hoá ra đến từ một lượt đọc kém — tức là một
   lỗi thật bị nhìn nhầm thành báo oan.
2. **Mọi thước đo phải hiệu chỉnh bằng mẫu chuẩn trước khi tin.** Nếu không dựng
   mẫu TTS sạch để đối chiếu, thước đo dải tần đã báo "hỏng" cho mọi file.
3. **Không tự tạo ra lỗi mà máy chấm không báo.** Sập bẫy này hai lần (thanh nhẹ,
   `perr_level_msg`). Chữ nào iFLYTEK bảo đúng thì hiển thị là đúng.
