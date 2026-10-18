/**
 * Dựng phần tổng hợp cho một lượt hoàn thành bài học, từ các bản ghi luyện nói.
 *
 * TOÀN BỘ FILE NÀY THUẦN, KHÔNG I/O — để test được bằng dữ liệu bày tay.
 *
 * GIỮ MỌI LƯỢT ĐỌC. Học viên đọc một câu năm lần thì cả năm bản ghi và cả năm
 * file ghi âm đều được giữ — khách muốn thấy học viên đọc mấy lần mới đạt, và
 * nghe lại được cả những lần chưa tốt để góp ý.
 *
 * Bản đầu chỉ giữ lượt cuối mỗi câu. Đổi lại thì đĩa tốn gấp vài lần, nhưng
 * tác vụ nén (AAC, nhỏ hơn ~7 lần) gánh phần lớn chỗ đó.
 */

/**
 * Sắp theo thời gian, CŨ TRƯỚC — đúng thứ tự học viên đã đọc.
 *
 * Phá thế bằng _id: hai bản ghi cùng mốc thời gian (đọc lại rất nhanh, hoặc
 * đồng hồ chỉ đến giây) thì thứ tự phụ thuộc vào thứ tự Mongo trả về, mà thứ
 * tự đó không được bảo đảm. ObjectId tăng dần theo thời gian tạo nên nó là
 * cái phá thế đúng nghĩa.
 */
function oldestFirst(a, b) {
    const ta = new Date(a.createdAt || 0).getTime()
    const tb = new Date(b.createdAt || 0).getTime()
    if (ta !== tb) return ta - tb
    return String(a._id).localeCompare(String(b._id))
}

const asInt = (v, fallback = -1) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
}

/**
 * Gom các lượt đọc về từng CÂU.
 *
 * "MỘT CÂU" = CẶP (videoIndex, lineIndex), KHÔNG phải riêng lineIndex.
 * lineIndex đánh số trong phạm vi MỘT video, nên bài 3 video thì câu đầu của
 * cả ba video đều là 0. Gom theo riêng lineIndex sẽ trộn ba câu khác nhau
 * thành một.
 *
 * Mỗi câu trả về:
 *   score / attemptId  -> của LƯỢT CUỐI. Đó là con số học viên thấy trên màn
 *                         hình lúc làm bài, và là con số đi vào điểm trung
 *                         bình — hai bên phải khớp nhau.
 *   attempts[]         -> MỌI lượt, cũ trước mới sau.
 */
function groupLineAttempts(attempts) {
    const list = Array.isArray(attempts) ? [...attempts] : []
    const byLine = new Map()

    for (const a of list.sort(oldestFirst)) {
        const video = asInt(a.videoIndex)
        const line = asInt(a.lineIndex)
        // lineIndex âm = không biết là câu nào (bản ghi cũ, hoặc client không
        // gửi). Không gom được thì để riêng từng bản ghi, thà thừa một dòng
        // còn hơn trộn nhầm hai câu khác nhau vào một.
        const key = line < 0 ? `u:${a._id}` : `${video}:${line}`

        if (!byLine.has(key)) {
            byLine.set(key, {
                videoIndex: video,
                lineIndex: line,
                hanzi: a.referenceText || '',
                pinyin: a.referencePinyin || '',
                score: null,
                attemptId: null,
                attempts: [],
            })
        }

        const row = byLine.get(key)
        row.attempts.push({
            attemptId: a._id,
            score: typeof a.pronScore === 'number' ? a.pronScore : null,
            at: a.createdAt || null,
        })
        // Ghi đè sau mỗi lượt -> cuối vòng là lượt mới nhất.
        row.score = typeof a.pronScore === 'number' ? a.pronScore : null
        row.attemptId = a._id
        // Câu mẫu lấy theo lượt mới nhất, phòng khi bài học được sửa giữa chừng.
        if (a.referenceText) row.hanzi = a.referenceText
        if (a.referencePinyin) row.pinyin = a.referencePinyin
    }

    return Array.from(byLine.values()).sort(
        (a, b) => a.videoIndex - b.videoIndex || a.lineIndex - b.lineIndex
    )
}

/**
 * Tổng hợp điểm luyện nói TỪ DỮ LIỆU MÁY CHỦ, không lấy từ trình duyệt.
 *
 * TÍNH TRÊN LƯỢT CUỐI CỦA MỖI CÂU, không tính trên mọi lượt đọc.
 *
 * Nếu lấy trung bình của tất cả các lượt thì học viên đọc đi đọc lại cho tốt
 * hơn lại bị điểm THẤP hơn người đọc một lần — và con số sẽ khác với cái họ
 * vừa nhìn thấy trên màn hình làm bài (SpeakingSection chỉ giữ lượt cuối).
 *
 * Bỏ qua câu không có điểm hợp lệ (iFLYTEK từ chối, hoặc đọc thiếu nên không
 * qua cổng chấm). Gộp chúng vào như số 0 sẽ kéo tụt điểm một cách oan uổng —
 * đúng luật mà SpeakingSection đang dùng ở phía trình duyệt.
 */
function summarizeSpeaking(lines) {
    const list = Array.isArray(lines) ? lines : []
    const scores = list
        .map((l) => l.score)
        .filter((n) => typeof n === 'number' && Number.isFinite(n))

    return {
        avgScore: scores.length
            ? Math.round(scores.reduce((x, y) => x + y, 0) / scores.length)
            : null,
        lineCount: list.length,
        scoredCount: scores.length,
        // Tổng số lượt đọc, kể cả đọc lại. Khác lineCount, và là con số nói
        // lên học viên phải thử bao nhiêu lần.
        totalReadings: list.reduce((s, l) => s + (l.attempts || []).length, 0),
    }
}

/**
 * Tổng hợp điểm bài tập của cả bài.
 *
 * CỘNG DỒN số câu đúng và tổng số câu của mọi video RỒI MỚI quy ra thang 100 —
 * không lấy trung bình các tỉ lệ phần trăm. Video 2 câu và video 20 câu mà cân
 * bằng nhau thì con số ra vô nghĩa.
 *
 * Bài không có bài tập nào trả về null hết, KHÔNG trả 0/0 = 0 điểm. Hai thứ đó
 * khác hẳn nhau với học viên đang nhìn vào màn hình kết quả.
 */
function summarizeExercise(videos) {
    const list = Array.isArray(videos) ? videos : []
    let correct = 0
    let total = 0
    let any = false

    for (const v of list) {
        const e = v && v.exercise
        if (!e) continue
        const t = Number(e.total)
        if (!Number.isFinite(t) || t <= 0) continue
        any = true
        correct += Math.max(0, Number(e.correct) || 0)
        total += t
    }

    if (!any) return { correct: null, total: null, score100: null }
    return { correct, total, score100: Math.round((correct / total) * 100) }
}

module.exports = {
    oldestFirst,
    groupLineAttempts,
    summarizeSpeaking,
    summarizeExercise,
}
