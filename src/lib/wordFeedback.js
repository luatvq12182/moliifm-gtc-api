/**
 * Chuyển kết quả chấm THEO TỪNG CHỮ của iFLYTEK thành nhận xét THEO TỪ.
 *
 * BỐI CẢNH: khách hàng phản hồi rằng chấm từng chữ tuy chi tiết nhưng "chấm và
 * sửa sai" — báo lỗi oan quá nhiều. Nguyên nhân đã xác định được từ dữ liệu
 * thật: lỗi oan dồn vào âm tiết THANH NHẸ (轻声), vốn ngắn và mờ nên máy hay
 * chấm sai (xem wordSegmentation.js).
 *
 * File này KHÔNG đụng tới điểm số. Điểm vẫn do pronunciationScore.js tính theo
 * đúng công thức cũ. Đây là tầng NHẬN XÉT chạy song song: gom chữ thành từ, chỉ
 * ra một từ đáng luyện nhất, và viết một câu góp ý bằng tiếng Việt.
 */

const { groupCharsIntoWords } = require('./wordSegmentation')

// Mức độ nghiêm trọng của lỗi, quy về thang 100.
//
// Tính từ CÁC CỜ LỖI (initial/final/tone) mà lib/iflytek.js trả về, không phải
// từ chuỗi tiếng Việt. Trước đây hàm này tra bảng theo chuỗi ("sai thanh mẫu",
// "sai thanh điệu"...) — cách đó vỡ ngay khi một chữ sai nhiều thứ cùng lúc và
// nhãn trở thành "sai thanh mẫu và thanh điệu", không khớp khoá nào trong bảng
// nên rơi về giá trị mặc định.
//
// Lỗi thanh mẫu/vận mẫu bị trừ NẶNG HƠN lỗi thanh điệu: đọc sai thanh thì âm
// tiết vẫn nhận ra được, còn đọc sai thanh mẫu hoặc vận mẫu là thành một chữ
// khác hẳn. Sai nhiều trục cùng lúc thì cộng dồn.
const DP_SCORE = {
    16: 10, // đọc thiếu
    32: 65, // đọc thừa  — lỗi nhịp, không phải lỗi phát âm
    64: 65, // đọc lặp
    128: 25, // đọc sai (thay thế)
}

function charScore(c) {
    if (c.ok) return 100

    const d = c.detail
    // Bản ghi cũ (lưu trước khi có `detail`) thì lùi về tra bảng theo chuỗi.
    if (!d) return LEGACY_ISSUE_SCORE[c.issue] ?? 45

    if (d.dp && DP_SCORE[d.dp] !== undefined) return DP_SCORE[d.dp]

    if (!d.initial && !d.final && !d.tone) {
        return d.unknown ? 55 : 100 // có lỗi nhưng không rõ trục -> trừ vừa phải
    }

    const segmentErrors = (d.initial ? 1 : 0) + (d.final ? 1 : 0)
    let score
    if (segmentErrors === 2) score = d.tone ? 25 : 30
    else if (segmentErrors === 1) score = d.tone ? 35 : 45
    else score = 70 // chỉ sai thanh điệu

    // perr_level_msg = 2 nghĩa là lỗi ở mức BIÊN, không phải sai hẳn (xem ghi
    // chú trong lib/iflytek.js). Ví dụ đo được: chữ 卫 sai vận mẫu ở mức 2 (hơi
    // lệch) trong khi chữ 好 sai ở mức 3 (sai hẳn). Nới tay cho lỗi mức biên
    // để học viên không bị đánh đồng với người đọc sai hoàn toàn.
    //
    // KHÔNG áp dụng cho lỗi thanh điệu: perr_level_msg chấm chất lượng âm đoạn
    // chứ không chấm thanh, nên với lỗi thanh thì con số này không nói lên điều
    // gì về mức độ. Nới tay dựa trên một chỉ số không liên quan là tự đánh lừa.
    if (d.errorLevel === 2 && !d.tone) score = Math.min(100, score + 18)

    return score
}

// Chỉ dùng cho bản ghi cũ chưa có cờ `detail`.
const LEGACY_ISSUE_SCORE = {
    '': 100,
    'sai thanh điệu': 70,
    'sai vận mẫu': 45,
    'sai thanh mẫu': 45,
    'sai âm và thanh điệu': 35,
    'phát âm chưa chuẩn': 55,
    'đọc thừa': 65,
    'đọc lặp': 65,
    'đọc sai (thay thế)': 25,
    'đọc thiếu': 10,
}

// LỊCH SỬ MỘT SAI LẦM — đọc trước khi định bật lại cơ chế này.
//
// Ban đầu file này hạ trọng số của âm tiết THANH NHẸ (轻声) xuống 0.35 và loại
// chúng khỏi việc xếp loại từ, với lập luận: thanh nhẹ đọc ngắn và mờ nên máy
// hay chấm oan.
//
// Lập luận đó dựa trên ĐÚNG MỘT ví dụ (chữ 字 trong 名字 bị gắn cờ). Khi có đủ
// dữ liệu để kiểm chứng thì nó sai ở cả hai đầu:
//
//  1. Lượt sinh ra ví dụ đó có phone_score = 63 — tức là một lượt đọc KÉM.
//     Chữ 字 bị gắn cờ nhiều khả năng là lỗi THẬT, không phải chấm oan.
//
//  2. Thống kê trên toàn bộ lượt đã lưu: chữ 么 (me5, thanh nhẹ) chỉ bị gắn cờ
//     ở các lượt đọc kém (điểm 55-88), và KHÔNG BAO GIỜ ở lượt đọc chuẩn
//     (điểm 90-97). Nó là tín hiệu phân biệt tốt — trấn áp nó là vứt đi thông
//     tin có giá trị.
//
//  3. Tỉ lệ bị gắn cờ của âm tiết thanh nhẹ (38-50%) không hề cao hơn âm tiết
//     thanh đầy đủ (38-42%).
//
// Lỗi chấm oan CÓ THẬT, nhưng nó nằm ở chỗ khác: các âm tiết THANH ĐẦY ĐỦ bị
// báo "sai thanh điệu" trong những lượt mà iFLYTEK cho phone_score = 100. Cách
// giảm đúng chỗ là hạ check_type từ 'hard' xuống 'common' (đã làm, đo được:
// thanh điệu 78 -> 89, bớt một chữ bị gắn cờ oan).
//
// Cơ chế đã được gỡ bỏ hoàn toàn. Nếu định làm lại: phải kiểm chứng trên các
// lượt ĐỌC CHUẨN (phone_score cao), không phải lượt đọc kém.

// Ngưỡng tham khảo cho ĐIỂM SỐ của một từ. Việc XẾP LOẠI (good/fair/weak) giờ
// lấy thẳng mức tệ nhất trong các chữ, không suy từ điểm — xem buildWord.
const WORST_GOOD = 100 // không có lỗi nào
const WORST_FAIR = 65 // chỉ sai thanh điệu, hoặc lỗi nhịp

/**
 * Xếp loại một từ.
 *
 * LỖI CỦA BẢN ĐẦU: dùng TRUNG BÌNH có trọng số để quyết định đúng/sai. Kết quả
 * là một lỗi thật bị chữ đúng bên cạnh pha loãng cho tới khi biến mất:
 *
 *   大卫 = 大 đúng (100) + 卫 sai thanh điệu (70)  ->  trung bình 85  ->  "tốt"
 *
 * Học viên nhìn thấy chip 大卫 màu XANH và dòng "cả câu đọc rất chuẩn", nhưng
 * mở chi tiết ra thì 卫 tô ĐỎ. Mâu thuẫn ngay trên cùng một màn hình.
 *
 * BẢN SỬA: tách bạch hai việc vốn khác nhau.
 *
 *   - TRẤN ÁP THANH NHẸ vẫn giữ, vì đó là nguồn báo sai oan có thật: bỏ hẳn các
 *     âm tiết thanh nhẹ ra khỏi việc xếp loại, MIỄN LÀ từ còn âm tiết thanh đầy
 *     đủ để xét. Nhờ vậy 名字 (字 zi9) và 怎么样 (么 me5) vẫn được tha.
 *
 *   - KHÔNG PHA LOÃNG lỗi ở âm tiết thanh đầy đủ: xếp loại theo âm tiết TỆ NHẤT
 *     trong số các âm tiết được xét, không lấy trung bình. Một chữ sai rõ ràng
 *     thì cả từ cần luyện, bất kể chữ bên cạnh đọc tốt tới đâu.
 *
 * ĐÁNH ĐỔI ĐÃ CHẤP NHẬN: nếu học viên đọc sai thật ở một âm tiết thanh nhẹ, ta
 * sẽ bỏ sót. Cố ý — thà bỏ sót vài lỗi nhẹ còn hơn báo oan hàng loạt, vì báo oan
 * làm học viên mất niềm tin vào toàn hệ thống. Phần chi tiết từng chữ vẫn hiện
 * đầy đủ cho ai muốn soi kỹ.
 */
function buildWord(group) {
    // Điểm số hiển thị: nửa từ âm tiết tệ nhất, nửa từ chất lượng chung. Nhờ vậy
    // con số và màu sắc không chỏi nhau (một từ bị xếp "cần luyện" không thể
    // mang điểm 85).
    const average =
        group.length > 0 ? group.reduce((sum, c) => sum + charScore(c), 0) / group.length : 100

    // Xét MỌI âm tiết, kể cả thanh nhẹ (xem ghi chú ở đầu file về việc vì sao
    // không còn loại trừ thanh nhẹ nữa).
    let worst = 100
    let dominant = null
    group.forEach((c) => {
        const sc = charScore(c)
        if (sc < worst) {
            worst = sc
            dominant = c
        }
    })

    const score = Math.round(0.5 * worst + 0.5 * average)

    // Mức của TỪ = mức TỆ NHẤT trong các chữ của nó, lấy thẳng từ c.level.
    //
    // Trước đây mức của từ suy từ điểm số (`worst`), mà charScore trả về 100 cho
    // MỌI chữ được coi là đúng — kể cả chữ ở mức 'fair' (hơi lệch, perr_level_msg=2).
    // Hậu quả: từ 天气 hiện XANH trong khi chữ 气 bên trong hiện VÀNG. Lại đúng
    // kiểu mâu thuẫn "viền nói một đằng, chữ nói một nẻo" đã phải sửa một lần rồi.
    //
    // Lấy thẳng từ c.level thì hai tầng KHÔNG THỂ lệch nhau: màu của từ luôn
    // bằng màu của chữ tệ nhất trong nó, theo đúng định nghĩa chứ không phải
    // nhờ hai phép tính riêng biệt tình cờ cho ra cùng kết quả.
    const LEVEL_RANK = { good: 0, fair: 1, weak: 2 }
    const worstRank = group.reduce((acc, c) => {
        const rank = LEVEL_RANK[c.level] ?? (c.ok ? 0 : 2) // bản ghi cũ chưa có level
        return rank > acc ? rank : acc
    }, 0)
    const status = ['good', 'fair', 'weak'][worstRank]

    return {
        content: group.map((c) => c.content).join(''),
        pinyin: group.map((c) => c.pinyin).join(' '),
        score,
        status,
        issue: status === 'good' ? '' : dominant ? dominant.issue : '',
        chars: group,
    }
}

// Câu góp ý bằng tiếng Việt. Nêu tên cụ thể một từ đọc tốt và một từ cần luyện
// — cụ thể thì học viên mới biết làm gì tiếp theo, chứ "hãy luyện thêm" thì vô
// nghĩa.
//
// QUY TẮC BẤT DI BẤT DỊCH: câu này KHÔNG được nói "hoàn hảo/không có gì cần
// chỉnh" nếu phần chi tiết từng chữ vẫn còn chữ bị gắn cờ. Trước đây nó nói
// "Cả câu bạn đọc rất chuẩn" trong khi mở chi tiết ra thấy 3 chữ tô đỏ —
// hai thông điệp chỏi nhau trên cùng một màn hình thì học viên không tin cái nào.
function buildFeedback(words) {
    if (words.length === 0) return ''

    // Phân biệt SAI HẲN với HƠI LỆCH. Gộp chung hai loại lại thì câu phản hồi
    // liệt kê gần hết số từ trong câu và nghe như học viên chẳng đọc được gì —
    // trong khi thực tế phần lớn chỉ lệch nhẹ. Có ba mức thì phải dùng cả ba.
    const weak = words.filter((w) => w.status === 'weak').sort((a, b) => a.score - b.score)
    const fair = words.filter((w) => w.status === 'fair').sort((a, b) => a.score - b.score)
    const good = words.filter((w) => w.status === 'good').sort((a, b) => b.score - a.score)

    if (weak.length === 0 && fair.length === 0) {
        return 'Cả câu bạn đọc rất chuẩn, không có từ nào cần chỉnh. Giữ nguyên phong độ này nhé!'
    }

    const parts = []
    if (good.length > 0) {
        parts.push(`Từ ${good[0].content} bạn đọc rất rõ!`)
    }

    if (weak.length > 0) {
        // Có từ sai hẳn -> đó là ưu tiên duy nhất. Không nhắc tới các từ chỉ hơi
        // lệch, để học viên tập trung vào đúng một chỗ.
        if (weak.length === 1) {
            parts.push(`Từ ${weak[0].content} cần luyện lại kỹ.`)
        } else {
            const others = weak.slice(1, 3).map((w) => w.content).join('、')
            parts.push(`Từ ${weak[0].content} cần luyện lại kỹ, sau đó tới ${others}.`)
        }
    } else {
        // Chỉ toàn lỗi nhẹ -> nói rõ là gần đạt rồi, đừng làm học viên nản.
        const list = fair.slice(0, 2).map((w) => w.content).join('、')
        parts.push(
            fair.length === 1
                ? `Từ ${list} gần chuẩn rồi, chỉnh thêm chút nữa là đạt.`
                : `Cả câu gần chuẩn rồi, chỉ cần chỉnh nhẹ ở ${list}.`
        )
    }

    return parts.join(' ')
}

/**
 * chars: kết quả từng chữ đã được lib/iflytek.js diễn giải
 * referencePinyin: phiên âm câu mẫu lấy từ dữ liệu bài học
 *
 * Trả về { words, method, focusWord, feedback }
 *   focusWord — MỘT từ đáng luyện nhất, hoặc null nếu cả câu đều tốt.
 *   Cố ý chỉ nêu một: đưa cùng lúc năm chỗ cần sửa thì học viên không sửa chỗ nào.
 */
function buildWordFeedback(chars, referencePinyin) {
    const { groups, method } = groupCharsIntoWords(chars || [], referencePinyin)
    const words = groups.map(buildWord)

    // Từ tiêu điểm BẮT BUỘC phải có lỗi thật (issue khác rỗng). Trước đây chỉ
    // lọc theo status !== 'good', nên một từ không hề có lỗi vẫn bị đưa lên thẻ
    // "cần luyện lại" kèm dòng mặc định "Phát âm chưa đúng" — trong khi chẳng
    // có gì chưa đúng cả.
    const weakest = words
        .filter((w) => w.status !== 'good' && w.issue)
        .sort((a, b) => a.score - b.score)[0]

    return {
        words,
        method,
        focusWord: weakest || null,
        feedback: buildFeedback(words),
    }
}

module.exports = { buildWordFeedback, WORST_GOOD, WORST_FAIR }
