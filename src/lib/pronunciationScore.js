/**
 * Quy đổi kết quả thô của iFLYTEK thành ĐIỂM hiển thị.
 *
 * ===========================================================================
 * ĐANG DÙNG: điểm tổng do CHÍNH iFLYTEK tính (thuộc tính total_score trong XML)
 * ===========================================================================
 *
 * Trước đây ta tự cộng 4 tiêu chí, mỗi tiêu chí quy về /25 rồi lấy tổng /100 —
 * cách này do khách hàng đề xuất từ đầu. Nó đã được TẠM TẮT (xem phần bị comment
 * bên dưới), vì đo trên dữ liệu thật cho thấy nó phân biệt kém hơn hẳn:
 *
 *                        Công thức tự cộng    iFLYTEK total_score
 *   Bài đọc SAI                  81                  67,5
 *   Bài đọc ĐƯỢC                 84                  86,2
 *   Khoảng cách                   3 điểm             18,7 điểm
 *
 * Nguyên nhân: tiêu chí "Đầy đủ" gần như luôn bằng 100 (chỉ tụt khi học viên bỏ
 * sót chữ), nên nó cho không 25 điểm và kéo bài đọc sai lên cao. iFLYTEK cân
 * trọng số khác hẳn và phạt bài đọc sai nặng hơn nhiều.
 *
 * MUỐN QUAY LẠI CÁCH CŨ: bỏ comment khối bên dưới, đồng thời sửa CẢ hai nơi —
 * file này (dùng để ghi lịch sử) VÀ gtc-fe/src/lib/iflytekSpeech.js (dùng để
 * hiển thị cho học viên). Sửa một bên mà quên bên kia thì điểm học viên nhìn
 * thấy sẽ khác điểm lưu trong lịch sử, và mọi việc đối chứng về sau đều sai.
 */

const clamp100 = (v) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : 0)

// ---------------------------------------------------------------------------
// CÁCH TÍNH CŨ — TẠM TẮT
// iFLYTEK trả mỗi tiêu chí trên thang 100 -> chia 4 để ra /25 rồi cộng lại.
//
// const toQuarter = (v) => (typeof v === 'number' ? Math.round(v / 4) : 0)
//
// function computePronunciationScore(summary = {}) {
//     const parts = {
//         accuracy: toQuarter(summary.phone_score),
//         prosody: toQuarter(summary.tone_score),
//         fluency: toQuarter(summary.fluency_score),
//         completeness: toQuarter(summary.integrity_score),
//     }
//     if (summary.is_rejected) return { score: null, parts }
//     const score = parts.accuracy + parts.prosody + parts.fluency + parts.completeness
//     return { score, parts }
// }
// ---------------------------------------------------------------------------

/**
 * summary: { total_score, phone_score, tone_score, fluency_score, integrity_score, is_rejected }
 * Trả về { score, parts } — score = null khi bài bị iFLYTEK từ chối.
 *
 * parts giữ nguyên thang /100 như iFLYTEK trả về (KHÔNG quy về /25 nữa): quy đổi
 * thì bốn con số không còn cộng lại thành điểm tổng, nhìn sẽ khó hiểu.
 */
function computePronunciationScore(summary = {}) {
    const round = (v) => (typeof v === 'number' ? Math.round(clamp100(v)) : null)

    const parts = {
        accuracy: round(summary.phone_score), // "Phát âm"
        prosody: round(summary.tone_score), // "Thanh điệu"
        fluency: round(summary.fluency_score), // "Trôi chảy"
        completeness: round(summary.integrity_score), // "Đầy đủ"
    }

    if (summary.is_rejected) {
        return { score: null, parts }
    }

    return { score: round(summary.total_score), parts }
}

module.exports = { computePronunciationScore, clamp100 }
