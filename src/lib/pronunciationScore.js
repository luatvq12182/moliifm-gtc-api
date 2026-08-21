/**
 * Quy đổi kết quả thô của iFLYTEK thành ĐIỂM hiển thị.
 *
 * Công thức: mỗi tiêu chí trong 4 tiêu chí của iFLYTEK (thang 100) quy về /25
 * rồi cộng lại thành tổng /100.
 *
 * ---------------------------------------------------------------------------
 * CẢNH BÁO — CÔNG THỨC NÀY BỊ LẶP Ở HAI NƠI:
 *   - gtc-api/src/lib/pronunciationScore.js   (file này, dùng để ghi lịch sử)
 *   - gtc-fe/src/lib/iflytekSpeech.js         (dùng để hiển thị cho học viên)
 *
 * Sửa một bên mà quên bên kia thì điểm học viên nhìn thấy sẽ khác điểm lưu
 * trong lịch sử, và mọi việc đối chứng về sau đều sai. SỬA THÌ SỬA CẢ HAI.
 *
 * (Đã từng thử dồn về một nguồn duy nhất ở máy chủ, nhưng cách tính điểm được
 * quyết định giữ nguyên như cũ, nên giữ nguyên luôn cấu trúc hiện có.)
 * ---------------------------------------------------------------------------
 */

const clamp100 = (v) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : 0)

// iFLYTEK trả mỗi tiêu chí trên thang 100 -> chia 4 để ra /25.
const toQuarter = (v) => (typeof v === 'number' ? Math.round(v / 4) : 0)

/**
 * summary: { phone_score, tone_score, fluency_score, integrity_score, is_rejected }
 * Trả về { score, parts } — score = null khi bài bị iFLYTEK từ chối.
 */
function computePronunciationScore(summary = {}) {
    const parts = {
        accuracy: toQuarter(summary.phone_score), // "Phát âm"  ~ phone_score
        prosody: toQuarter(summary.tone_score), // "Thanh điệu" ~ tone_score
        fluency: toQuarter(summary.fluency_score), // "Trôi chảy"
        completeness: toQuarter(summary.integrity_score), // "Đầy đủ"
    }

    if (summary.is_rejected) {
        return { score: null, parts }
    }

    const score = parts.accuracy + parts.prosody + parts.fluency + parts.completeness
    return { score, parts }
}

module.exports = { computePronunciationScore, clamp100 }
