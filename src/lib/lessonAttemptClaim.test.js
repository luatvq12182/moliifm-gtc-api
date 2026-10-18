/**
 * Test cho phần tổng hợp một lượt hoàn thành bài học.
 *
 *   npm test
 */
const { test } = require('node:test')
const assert = require('assert')

const {
    groupLineAttempts,
    summarizeSpeaking,
    summarizeExercise,
} = require('./lessonAttemptClaim')

const at = (id, lineIndex, minutes, pronScore, videoIndex = 0) => ({
    _id: id,
    videoIndex,
    lineIndex,
    createdAt: new Date(2026, 0, 1, 10, minutes),
    pronScore,
    referenceText: 'câu ' + lineIndex,
    referencePinyin: 'cau ' + lineIndex,
})

// ---------- gom lượt đọc theo câu ----------

test('GIỮ MỌI LƯỢT ĐỌC của cùng một câu', () => {
    const lines = groupLineAttempts([
        at('a1', 0, 1, 40),
        at('a2', 0, 5, 62),
        at('a3', 0, 9, 81),
    ])
    assert.strictEqual(lines.length, 1, 'ba lượt của cùng một câu -> một dòng')
    assert.deepStrictEqual(lines[0].attempts.map((x) => x.score), [40, 62, 81])
})

test('lượt đọc xếp CŨ TRƯỚC, để thấy được tiến bộ trong buổi', () => {
    const lines = groupLineAttempts([at('b', 0, 9, 81), at('a', 0, 1, 40)])
    assert.deepStrictEqual(lines[0].attempts.map((x) => x.attemptId), ['a', 'b'])
})

test('điểm của câu = LƯỢT CUỐI, không phải lượt cao nhất hay trung bình', () => {
    // Phải khớp với con số học viên thấy trên màn hình làm bài —
    // SpeakingSection chỉ giữ kết quả lần cuối.
    const lines = groupLineAttempts([at('a', 0, 1, 95), at('b', 0, 5, 60)])
    assert.strictEqual(lines[0].score, 60)
    assert.strictEqual(lines[0].attemptId, 'b')
})

test('cùng mốc thời gian -> phá thế bằng _id, kết quả không đổi giữa các lần chạy', () => {
    const a = { _id: 'aaa', videoIndex: 0, lineIndex: 0, createdAt: new Date(2026, 0, 1), pronScore: 1 }
    const b = { _id: 'bbb', videoIndex: 0, lineIndex: 0, createdAt: new Date(2026, 0, 1), pronScore: 2 }
    assert.strictEqual(groupLineAttempts([a, b])[0].score, 2)
    assert.strictEqual(groupLineAttempts([b, a])[0].score, 2, 'thứ tự đầu vào không được làm đổi kết quả')
})

test('BÀI NHIỀU VIDEO: câu đầu của hai video KHÔNG bị trộn làm một', () => {
    // lineIndex đánh số trong phạm vi MỘT video, nên bài 3 video thì câu đầu
    // của cả ba đều là 0.
    const lines = groupLineAttempts([
        at('v0', 0, 1, 70, 0),
        at('v1', 0, 2, 80, 1),
        at('v2', 0, 3, 90, 2),
    ])
    assert.strictEqual(lines.length, 3)
    assert.deepStrictEqual(lines.map((l) => l.videoIndex), [0, 1, 2])
})

test('sắp theo thứ tự học viên gặp: video trước, rồi câu trong video', () => {
    const lines = groupLineAttempts([
        at('b', 1, 1, 60, 1),
        at('d', 0, 2, 60, 2),
        at('a', 0, 3, 60, 0),
        at('c', 0, 4, 60, 1),
    ])
    assert.deepStrictEqual(
        lines.map((l) => `v${l.videoIndex}l${l.lineIndex}`),
        ['v0l0', 'v1l0', 'v1l1', 'v2l0'],
    )
})

test('lineIndex âm = không biết là câu nào -> mỗi bản ghi một dòng riêng', () => {
    // Thà thừa một dòng còn hơn trộn nhầm hai câu khác nhau vào một.
    const lines = groupLineAttempts([at('u1', -1, 1, 50), at('u2', -1, 2, 60), at('ok', 0, 3, 70)])
    assert.strictEqual(lines.length, 3)
})

test('giữ nguyên câu mẫu để lịch sử đọc được khi bài học bị xoá', () => {
    const lines = groupLineAttempts([at('a', 0, 1, 75)])
    assert.strictEqual(lines[0].hanzi, 'câu 0')
    assert.strictEqual(lines[0].pinyin, 'cau 0')
})

test('danh sách rỗng / rác -> không nổ', () => {
    assert.deepStrictEqual(groupLineAttempts([]), [])
    assert.deepStrictEqual(groupLineAttempts(undefined), [])
    assert.deepStrictEqual(groupLineAttempts(null), [])
})

test('KHÔNG làm thay đổi mảng gốc của nơi gọi', () => {
    const input = [at('a', 1, 1, 10), at('b', 0, 2, 20)]
    const before = input.map((x) => x._id)
    groupLineAttempts(input)
    assert.deepStrictEqual(input.map((x) => x._id), before)
})

// ---------- tổng hợp điểm luyện nói ----------

test('điểm trung bình tính trên LƯỢT CUỐI, không trên mọi lượt đọc', () => {
    // Đọc lại cho tốt hơn mà bị điểm thấp hơn người đọc một lần là vô lý, và
    // con số sẽ lệch với cái học viên vừa thấy lúc làm bài.
    const lines = groupLineAttempts([
        at('a1', 0, 1, 30),
        at('a2', 0, 2, 50),
        at('a3', 0, 3, 90), // lượt cuối câu 0
        at('b1', 1, 4, 70), // câu 1, đọc một lần
    ])
    const r = summarizeSpeaking(lines)
    assert.strictEqual(r.avgScore, 80, '(90 + 70) / 2, không phải (30+50+90+70)/4')
    assert.strictEqual(r.lineCount, 2)
    assert.strictEqual(r.totalReadings, 4, 'vẫn đếm đủ số lượt đã đọc')
})

test('điểm trung bình BỎ QUA câu không chấm được', () => {
    const lines = groupLineAttempts([at('a', 0, 1, 80), at('b', 1, 2, null), at('c', 2, 3, 90)])
    const r = summarizeSpeaking(lines)
    assert.strictEqual(r.avgScore, 85)
    assert.strictEqual(r.lineCount, 3, 'vẫn đếm đủ số câu đã đọc')
    assert.strictEqual(r.scoredCount, 2, 'nhưng nói rõ trung bình dựa trên mấy câu')
})

test('lượt cuối bị từ chối thì câu đó không tính, dù lượt trước có điểm', () => {
    // Đúng với cái học viên nhìn thấy: màn hình hiện kết quả lượt CUỐI.
    const lines = groupLineAttempts([at('a1', 0, 1, 88), at('a2', 0, 5, null)])
    const r = summarizeSpeaking(lines)
    assert.strictEqual(r.avgScore, null)
    assert.strictEqual(r.scoredCount, 0)
    assert.strictEqual(r.totalReadings, 2)
})

test('không câu nào chấm được -> avgScore null, không phải 0', () => {
    const r = summarizeSpeaking(groupLineAttempts([at('a', 0, 1, null)]))
    assert.strictEqual(r.avgScore, null)
})

test('summarizeSpeaking: dữ liệu rác không lọt vào phép tính', () => {
    const r = summarizeSpeaking([
        { score: 80, attempts: [{}] },
        { score: NaN, attempts: [{}] },
        { score: 'tốt', attempts: [{}] },
    ])
    assert.strictEqual(r.avgScore, 80)
    assert.strictEqual(r.scoredCount, 1)
})

test('summarizeSpeaking: danh sách rỗng -> không nổ', () => {
    assert.deepStrictEqual(summarizeSpeaking([]), {
        avgScore: null, lineCount: 0, scoredCount: 0, totalReadings: 0,
    })
    assert.strictEqual(summarizeSpeaking(undefined).lineCount, 0)
})

// ---------- tổng hợp điểm bài tập ----------

test('cộng dồn câu đúng rồi mới quy thang 100, KHÔNG trung bình tỉ lệ', () => {
    // Video 1: 1/2 = 50%. Video 2: 18/20 = 90%.
    // Trung bình tỉ lệ ra 70% — sai, vì video 2 câu không nặng bằng video 20 câu.
    // Cộng dồn: 19/22 = 86%.
    const r = summarizeExercise([
        { exercise: { correct: 1, total: 2 } },
        { exercise: { correct: 18, total: 20 } },
    ])
    assert.deepStrictEqual(r, { correct: 19, total: 22, score100: 86 })
})

test('bài KHÔNG có bài tập -> null hết, KHÔNG phải 0 điểm', () => {
    assert.deepStrictEqual(summarizeExercise([{ exercise: { correct: 0, total: 0 } }]), {
        correct: null, total: null, score100: null,
    })
    assert.deepStrictEqual(summarizeExercise([]), { correct: null, total: null, score100: null })
    assert.deepStrictEqual(summarizeExercise([{}]).score100, null)
})

test('một video có bài tập, một video không -> chỉ tính video có', () => {
    const r = summarizeExercise([
        { exercise: { correct: 0, total: 0 } },
        { exercise: { correct: 5, total: 10 } },
    ])
    assert.deepStrictEqual(r, { correct: 5, total: 10, score100: 50 })
})

test('làm sai hết -> 0 điểm, KHÁC HẲN null', () => {
    assert.deepStrictEqual(summarizeExercise([{ exercise: { correct: 0, total: 8 } }]), {
        correct: 0, total: 8, score100: 0,
    })
})
