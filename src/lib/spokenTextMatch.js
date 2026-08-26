/**
 * Đối chiếu câu mà bộ NHẬN DẠNG (IAT) nghe được với câu mẫu, rồi dùng tỉ lệ
 * khớp làm TRẦN cho điểm.
 *
 * ---------------------------------------------------------------------------
 * VÌ SAO CẦN
 *
 * iFLYTEK ISE là bộ chấm ĐỌC THEO VĂN BẢN CÓ SẴN. Nó nhận câu mẫu trước, rồi
 * ÉP KHỚP (force-align) đoạn ghi âm vào câu mẫu đó và chấm xem từng mảnh khớp
 * tới đâu. Nó KHÔNG kiểm tra xem học viên có thật sự đọc đúng câu đó không —
 * đọc ra chữ gì nó cũng cố ép vào khung câu mẫu.
 *
 * Ví dụ thật (24/08/2026), người chưa từng học tiếng Trung đọc:
 *
 *   Câu mẫu   : 今天天气很好啊  不冷不热  很舒服
 *   IAT nghe  : 今天天气很好啊  母狼哺乳  很舒服
 *
 * 母狼哺乳 nghĩa là "sói mẹ cho con bú" — bốn âm tiết bị nghe thành bốn chữ
 * khác hẳn. Vậy mà ISE vẫn chấm 83 điểm, với Thanh điệu 86 và Trôi chảy 85:
 * người này đọc TRÔI, chỉ là trôi mà sai.
 *
 * IAT thì KHÔNG biết câu mẫu — nghe được gì ghi nấy. Nhờ vậy nó là NHÂN CHỨNG
 * ĐỘC LẬP, bắt được đúng thứ mà bộ ép khớp bỏ sót.
 *
 * ---------------------------------------------------------------------------
 * NGUYÊN TẮC AN TOÀN
 *
 * Cơ chế này CHỈ SIẾT khi có bằng chứng rõ ràng, không bao giờ tự tạo lỗi:
 *
 *  - IAT trả về rỗng (lỗi mạng, quá hạn 4 giây) -> KHÔNG áp trần. Áp trần khi
 *    IAT chết là biến một sự cố kỹ thuật thành điểm kém oan cho học viên.
 *  - Câu quá ngắn (dưới 4 chữ Hán) -> KHÔNG áp trần: tỉ lệ khớp trên 2-3 chữ
 *    quá thô, sai một chữ đã tụt 33%.
 *  - Khớp từ 90% trở lên -> KHÔNG áp trần. Chừa khoảng cho IAT nghe nhầm một
 *    hai chữ ở bài đọc vốn đã tốt.
 */

// Chỉ giữ chữ Hán; bỏ dấu câu, khoảng trắng, chữ Latin.
function onlyHanzi(text) {
    const kept = (text || '').match(/[一-鿿]/g)
    return kept ? kept.join('') : ''
}

/**
 * Dãy con chung dài nhất, có truy vết để biết CHỮ NÀO trong câu mẫu không khớp.
 *
 * Dùng dãy con chung (LCS) chứ không so từng vị trí: IAT có thể nghe thừa hoặc
 * thiếu chữ, so theo vị trí thì lệch một chữ là hỏng toàn bộ phần sau.
 *
 * Câu dài nhất trong giáo trình chỉ vài chục chữ nên bảng O(n*m) là không đáng kể.
 */
function lcsMatchedIndexes(ref, spoken) {
    const n = ref.length
    const m = spoken.length
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i][j] =
                ref[i - 1] === spoken[j - 1]
                    ? dp[i - 1][j - 1] + 1
                    : Math.max(dp[i - 1][j], dp[i][j - 1])
        }
    }

    const matched = new Set()
    let i = n
    let j = m
    while (i > 0 && j > 0) {
        if (ref[i - 1] === spoken[j - 1]) {
            matched.add(i - 1)
            i--
            j--
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            i--
        } else {
            j--
        }
    }
    return matched
}

const MIN_REF_CHARS = 4 // câu ngắn hơn thì tỉ lệ khớp quá thô, không dùng

// Số chữ được phép nghe nhầm mà KHÔNG bị siết điểm.
//
// IAT nghe nhầm một hai chữ là chuyện thường, kể cả với bài đọc tốt. Trong dữ
// liệu thật, câu 大卫，今天天气怎么样？ liên tục bị nghe thành 大为 hoặc 大圩 —
// chỉ một chữ, và người đọc hoàn toàn không sai. Nếu siết theo tỉ lệ trần trụi
// thì 8/9 chữ khớp = 89%, đủ để hạ một bài đọc 95 điểm xuống 89. Đó là biến
// nhiễu của IAT thành điểm kém oan — đúng cái bẫy đã sập hai lần rồi.
//
// Dung sai: 2 chữ, hoặc 10% câu nếu câu dài. Chỉ khi vượt quá mới siết.
const TOLERATED_MISSES = 2
const TOLERATED_RATIO = 0.1

// Sàn của trần điểm. IAT cũng có lúc nghe ra toàn chữ vô nghĩa với giọng nặng,
// nên dù khớp 0% cũng không hạ xuống 0 — hạ tới mức này là đủ để học viên hiểu
// bài đọc chưa đạt, mà không biến một cú trượt của IAT thành điểm 0.
const CAP_FLOOR = 30

/**
 * referenceText: câu mẫu (chữ Hán)
 * spokenText   : câu IAT nghe được
 *
 * Trả về:
 *   applicable  — có đủ điều kiện để áp trần không
 *   ratio       — tỉ lệ chữ trong câu mẫu được nghe đúng (0..1)
 *   matched/total
 *   missedText  — các chữ trong câu mẫu KHÔNG được nghe ra, ghép lại
 *   cap         — trần điểm (null = không siết)
 */
function computeSpokenMatch(referenceText, spokenText) {
    const ref = onlyHanzi(referenceText)
    const spoken = onlyHanzi(spokenText)

    const base = {
        applicable: false,
        ratio: null,
        matched: 0,
        total: ref.length,
        missedText: '',
        cap: null,
    }

    // IAT không trả về gì -> không có bằng chứng -> không siết.
    if (!spoken) return base
    if (ref.length < MIN_REF_CHARS) return base

    const matchedIdx = lcsMatchedIndexes(ref, spoken)
    const ratio = matchedIdx.size / ref.length

    const missedText = ref
        .split('')
        .filter((_, i) => !matchedIdx.has(i))
        .join('')

    const result = {
        applicable: true,
        ratio: Math.round(ratio * 1000) / 1000,
        matched: matchedIdx.size,
        total: ref.length,
        missedText,
        cap: null,
    }

    const missed = ref.length - matchedIdx.size
    const tolerance = Math.max(TOLERATED_MISSES, Math.ceil(ref.length * TOLERATED_RATIO))
    result.tolerance = tolerance
    result.missed = missed

    // Trần điểm khi vượt dung sai.
    //
    // BẢN ĐẦU dùng thẳng `tỉ lệ khớp × 100`, và nó QUÁ RỘNG LƯỢNG. Đo trên ca
    // thật: học viên đọc 怎么样 thay cho 很好啊 — thay hẳn một cụm từ — khớp
    // 11/14 = 78,6% nên trần là 79. iFLYTEK cũng chấm đúng 79, thành ra cơ chế
    // không siết được gì cả.
    //
    // Vấn đề của phép nhân tuyến tính: sai 3/14 chữ chỉ trừ 21%. Nhưng khi IAT
    // nghe ra CHỮ KHÁC thì đó không phải "đọc hơi lệch" — đó là đọc sang một
    // từ khác hẳn, và mức độ nghiêm trọng tăng nhanh hơn nhiều so với số chữ.
    //
    // Dùng BÌNH PHƯƠNG tỉ lệ để phạt tăng dần:
    //   khớp 11/14 (78,6%) -> trần 62   (thay một cụm từ)
    //   khớp 10/14 (71,4%) -> trần 51   (đọc ra 母狼哺乳)
    //   khớp  6/9  (66,7%) -> trần 44
    //   khớp  0%           -> trần 30   (sàn)
    if (missed > tolerance) {
        result.cap = Math.max(CAP_FLOOR, Math.round(ratio * ratio * 100))
    }
    return result
}

module.exports = { computeSpokenMatch, onlyHanzi, MIN_REF_CHARS, TOLERATED_MISSES, CAP_FLOOR }
