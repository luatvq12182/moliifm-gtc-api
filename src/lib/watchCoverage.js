/**
 * Đếm thời lượng video học viên ĐÃ THỰC SỰ XEM.
 *
 * Trình phát gửi các đoạn vừa phát [từ, đến] (giây). Máy chủ gộp lại thành
 * danh sách đoạn không chồng nhau; tổng độ dài = thời lượng đã xem. Tua tới
 * không tạo đoạn nào, xem lại một đoạn không cộng hai lần.
 *
 * Chặn gửi khống: mỗi lần báo chỉ được cộng PHẦN MỚI tối đa bằng (thời gian
 * thực trôi qua từ lần báo trước × tốc độ phát lớn nhất) + một chút dư. Ai sửa
 * trình duyệt gửi "đã xem cả video" trong một lần cũng chỉ được cộng vài chục
 * giây.
 */

const MAX_SPEED = 2 // trình phát cho chọn tới 2x
const SLACK_SEC = 15 // mạng chậm, báo dồn
const FIRST_REPORT_BUDGET = 30 // lần báo đầu tiên (chưa có mốc thời gian)
const COMPLETE_RATIO = 0.95

/** Gộp các đoạn chồng / sát nhau (cách nhau dưới 1 giây coi như liền). */
function mergeIntervals(list) {
    const sorted = list
        .filter((x) => Array.isArray(x) && x.length === 2 && x[1] > x[0])
        .map(([s, e]) => [s, e])
        .sort((a, b) => a[0] - b[0])
    const out = []
    for (const [s, e] of sorted) {
        const last = out[out.length - 1]
        if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
        else out.push([s, e])
    }
    return out
}

const totalLength = (list) => list.reduce((sum, [s, e]) => sum + (e - s), 0)

/** Phần của đoạn [s, e] CHƯA nằm trong `merged` (đã gộp, đã sắp). */
function uncovered([s, e], merged) {
    const parts = []
    let cur = s
    for (const [a, b] of merged) {
        if (b <= cur) continue
        if (a >= e) break
        if (a > cur) parts.push([cur, Math.min(a, e)])
        cur = Math.max(cur, b)
        if (cur >= e) break
    }
    if (cur < e) parts.push([cur, e])
    return parts
}

/**
 * Cộng các đoạn mới vào `watched`.
 *
 * @param watched     đoạn đã có (đã gộp)
 * @param segments    đoạn trình phát vừa gửi — dữ liệu từ trình duyệt, không tin
 * @param duration    thời lượng video (giây), 0 = chưa biết
 * @param elapsedSec  thời gian thực từ lần báo trước, null = lần đầu
 * @returns { watched, watchedSec, added }
 */
function addSegments(watched, segments, { duration = 0, elapsedSec = null } = {}) {
    let merged = mergeIntervals(watched || [])
    let budget = elapsedSec === null ? FIRST_REPORT_BUDGET : Math.max(0, elapsedSec) * MAX_SPEED + SLACK_SEC
    let added = 0
    const max = duration > 0 ? duration : Infinity

    for (const seg of Array.isArray(segments) ? segments.slice(0, 200) : []) {
        if (!Array.isArray(seg) || seg.length !== 2) continue
        let [s, e] = seg.map(Number)
        if (!Number.isFinite(s) || !Number.isFinite(e)) continue
        s = Math.max(0, s)
        e = Math.min(max, e)
        if (e <= s) continue
        for (const [a, b] of uncovered([s, e], merged)) {
            if (budget <= 0) break
            const take = Math.min(b - a, budget)
            merged = mergeIntervals([...merged, [a, a + take]])
            budget -= take
            added += take
        }
    }
    // Làm tròn để bản ghi gọn (đơn vị 0,1 giây).
    merged = merged.map(([s, e]) => [Math.round(s * 10) / 10, Math.round(e * 10) / 10])
    return { watched: merged, watchedSec: Math.round(totalLength(merged) * 10) / 10, added }
}

/** Đã xem đủ chưa (>= 95% thời lượng). */
const isWatchComplete = (watchedSec, duration) => duration > 0 && watchedSec >= duration * COMPLETE_RATIO

module.exports = { mergeIntervals, addSegments, isWatchComplete, COMPLETE_RATIO }
