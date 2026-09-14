/**
 * WebSocket server cho chấm phát âm iFLYTEK, gắn vào HTTP server của gtc-api.
 *
 * Luồng:
 *   client mở WS -> gửi {type:'start', token, text, context} -> gửi các frame
 *   PCM (binary) -> gửi {type:'end'} -> server stream tới iFLYTEK (ISE + IAT)
 *   -> trả {type:'result', ...} hoặc {type:'error', message}.
 *
 * XÁC THỰC: bắt buộc có JWT học viên trong message 'start'.
 *   Vì sao đặt trong message chứ không phải query string của URL?
 *   URL của WebSocket bị ghi vào access log của Nginx/reverse proxy, nên token
 *   nằm trên URL là token bị lộ ra log. Đặt trong payload thì không.
 *   Đánh đổi: kết nối được mở trước khi xác thực, nên phải có HANDSHAKE_TIMEOUT
 *   để đóng ngay các kết nối không chịu xác thực.
 */

const WebSocket = require('ws')
const jwt = require('jsonwebtoken')
const { isConfigured, assessAndRecognize } = require('./iflytek')
const { features } = require('../config/features')
const { savePracticeAudio, SAMPLE_RATE } = require('./audioStorage')

// Trần độ dài XML lưu vào DB. XML của một câu ~14 chữ thường 20-60KB; đặt trần
// để một phản hồi bất thường không làm phình bản ghi.
const MAX_RAW_XML_CHARS = 256 * 1024
const { computePronunciationScore } = require('./pronunciationScore')
const { buildWordFeedback } = require('./wordFeedback')
const { toSpeakableText } = require('./numericText')
const { computeSpokenMatch } = require('./spokenTextMatch')
const Student = require('../models/Student')
const PracticeAttempt = require('../models/PracticeAttempt')

// Trần bộ đệm audio cho MỘT lượt đọc.
// 16000 mẫu/giây x 2 byte = 32 KB/giây. 90 giây ~ 2.8 MB. Câu dài nhất trong
// giáo trình chỉ vài giây, nên đây đã là mức rất rộng rãi.
// KHÔNG có trần thì một client (vô tình lặp vô hạn, hoặc cố ý) đẩy dữ liệu mãi
// sẽ làm cạn RAM máy chủ.
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 90

// Kết nối phải xác thực xong trong khoảng này, nếu không sẽ bị đóng.
const HANDSHAKE_TIMEOUT_MS = 15000

// Trần tuổi thọ của một kết nối, phòng trường hợp client treo mà không đóng.
const SESSION_TIMEOUT_MS = 5 * 60 * 1000

function attachPronunciationWs(httpServer, path = '/ws/pronunciation') {
    // noServer: tự xử lý 'upgrade' để chỉ nhận đúng path này, tránh đụng các
    // WS khác (nếu có) và để Nginx proxy dễ.
    const wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 })

    httpServer.on('upgrade', (req, socket, head) => {
        let pathname
        try {
            pathname = new URL(req.url, 'http://localhost').pathname
        } catch {
            pathname = req.url
        }
        if (pathname !== path) return // để handler khác xử lý / hoặc bỏ qua
        wss.handleUpgrade(req, socket, head, (client) => {
            wss.emit('connection', client, req)
        })
    })

    wss.on('connection', (client, req) => {
        let audioChunks = []
        let audioBytes = 0
        let referenceText = ''
        let context = {}
        let student = null // chỉ khác null sau khi xác thực thành công
        let started = false
        let scoring = false // đang chờ iFLYTEK -> chặn 'end' lặp

        const userAgent = (req && req.headers && req.headers['user-agent']) || ''

        const sendJson = (obj) => {
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj))
        }

        const fail = (message, code = 1008) => {
            sendJson({ type: 'error', message })
            try {
                client.close(code, 'error')
            } catch {
                /* bỏ qua */
            }
        }

        const reset = () => {
            audioChunks = []
            audioBytes = 0
        }

        // Đồng hồ ép xác thực: chưa 'start' hợp lệ trong 15s thì cắt.
        const handshakeTimer = setTimeout(() => {
            if (!student) fail('Hết thời gian chờ xác thực.', 4401)
        }, HANDSHAKE_TIMEOUT_MS)

        const sessionTimer = setTimeout(() => {
            fail('Phiên chấm điểm quá dài, đã tự đóng.', 4408)
        }, SESSION_TIMEOUT_MS)

        client.on('close', () => {
            clearTimeout(handshakeTimer)
            clearTimeout(sessionTimer)
            reset()
        })

        if (!isConfigured()) {
            sendJson({
                type: 'error',
                message: 'Máy chủ chưa cấu hình khóa iFLYTEK (XF_APPID/XF_API_KEY/XF_API_SECRET).',
            })
        }

        // Xác thực token học viên. Trả về document Student hoặc null.
        async function authenticate(token) {
            if (!token || typeof token !== 'string') return null
            let decoded
            try {
                decoded = jwt.verify(token, process.env.JWT_SECRET)
            } catch {
                return null
            }
            const found = await Student.findById(decoded.id)
            if (!found || found.status === 'locked') return null
            return found
        }

        // Ghi lịch sử luyện nói. Không bao giờ được làm hỏng luồng chấm điểm:
        // học viên đã có kết quả rồi, lưu trữ thất bại thì chỉ log lại.
        async function savePracticeHistory(pcm, assessment, spokenText, score, wordFeedback, spokenMatch) {
            if (!features.practiceHistoryEnabled) return
            try {
                const audio = await savePracticeAudio(student._id, pcm, SAMPLE_RATE)
                const s = assessment.summary || {}

                await PracticeAttempt.create({
                    student: student._id,
                    lesson: context.lessonId || null,
                    curriculumSlug: context.curriculumSlug || '',
                    courseSlug: context.courseSlug || '',
                    lessonSlug: context.lessonSlug || '',
                    lessonTitle: context.lessonTitle || '',
                    lineIndex: typeof context.lineIndex === 'number' ? context.lineIndex : -1,
                    referenceText,
                    referencePinyin: context.pinyin || '',
                    referenceVi: context.vi || '',
                    rawScores: {
                        total_score: s.total_score,
                        phone_score: s.phone_score,
                        tone_score: s.tone_score,
                        fluency_score: s.fluency_score,
                        integrity_score: s.integrity_score,
                    },
                    pronScore: score.score,
                    spokenMatch: spokenMatch
                        ? {
                            applicable: spokenMatch.applicable,
                            ratio: spokenMatch.ratio,
                            matched: spokenMatch.matched,
                            total: spokenMatch.total,
                            missedText: spokenMatch.missedText,
                            cap: spokenMatch.cap,
                            cappedFrom: score.cappedFrom ?? null,
                        }
                        : undefined,
                    words: wordFeedback.words.map((w) => ({
                        content: w.content,
                        pinyin: w.pinyin,
                        score: w.score,
                        status: w.status,
                        issue: w.issue,
                    })),
                    wordGroupingMethod: wordFeedback.method,
                    feedback: wordFeedback.feedback,
                    rawXml: (assessment.rawXml || '').slice(0, MAX_RAW_XML_CHARS),
                    isRejected: Boolean(s.is_rejected),
                    exceptInfo: s.except_info || null,
                    spokenText: spokenText || '',
                    chars: assessment.chars || [],
                    audioPath: audio.relativePath,
                    audioBytes: audio.bytes,
                    durationMs: audio.durationMs,
                    sampleRate: SAMPLE_RATE,
                    client: {
                        userAgent,
                        micLabel: context.micLabel || '',
                        micSampleRate: context.micSampleRate ?? null,
                        contextSampleRate: context.contextSampleRate ?? null,
                        resampleMode: context.resampleMode || '',
                        echoCancellation: context.echoCancellation ?? null,
                        noiseSuppression: context.noiseSuppression ?? null,
                        autoGainControl: context.autoGainControl ?? null,
                        captureMode: context.captureMode || '',
                    },
                })
            } catch (err) {
                console.error('[pronunciationWs] Lưu lịch sử luyện nói thất bại:', err.message)
            }
        }

        client.on('message', async (data, isBinary) => {
            if (!isBinary) {
                let m
                try {
                    m = JSON.parse(data.toString())
                } catch {
                    return
                }

                if (m.type === 'start') {
                    student = await authenticate(m.token)
                    if (!student) {
                        fail('Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.', 4401)
                        return
                    }
                    clearTimeout(handshakeTimer)
                    reset()
                    referenceText = (m.text || '').trim()
                    context = m.context && typeof m.context === 'object' ? m.context : {}
                    started = true
                    return
                }

                if (m.type === 'end') {
                    if (!student) {
                        fail('Chưa xác thực.', 4401)
                        return
                    }
                    if (!started) {
                        sendJson({ type: 'error', message: 'Chưa bắt đầu ghi âm.' })
                        return
                    }
                    if (scoring) return // đã nhận 'end' rồi, bỏ qua lần lặp

                    // Thông tin thiết bị chỉ biết được sau khi mic đã mở, nên
                    // client gửi kèm ở 'end' chứ không phải 'start'.
                    if (m.capture && typeof m.capture === 'object') {
                        context = { ...context, ...m.capture }
                    }

                    const pcm = Buffer.concat(audioChunks)
                    if (pcm.length === 0) {
                        sendJson({
                            type: 'error',
                            message: 'Không nghe thấy bạn nói gì cả. Bấm mic rồi đọc to, rõ ràng nhé.',
                        })
                        return
                    }
                    if (!referenceText) {
                        sendJson({ type: 'error', message: 'Thiếu câu mẫu để chấm.' })
                        return
                    }

                    // iFLYTEK từ chối câu mẫu KHÔNG CÓ CHỮ HÁN nào. Dòng thoại
                    // là số điện thoại trần ("2038559800。") vì thế chết với mã
                    // lỗi 8195 ở mọi lượt. Đổi sang số Hán theo phiên âm của
                    // chính dòng đó — xem lib/numericText.js.
                    const speakable = toSpeakableText(referenceText, context.pinyin)
                    if (!speakable.text) {
                        console.warn('[luyện nói] Câu mẫu không đọc được:', referenceText)
                        sendJson({
                            type: 'error',
                            message: 'Câu này chưa chấm được vì không có chữ Hán. Báo giáo viên kiểm tra lại nội dung bài nhé.',
                        })
                        return
                    }
                    if (speakable.changed) {
                        console.log(
                            `[luyện nói] Câu mẫu "${referenceText}" -> "${speakable.text}" (theo ${speakable.source})`
                        )
                    }

                    scoring = true
                    try {
                        const { assessment, spokenText } = await assessAndRecognize(pcm, speakable.text)

                        const score = computePronunciationScore(assessment.summary)

                        // NHÂN CHỨNG ĐỘC LẬP: IAT không biết câu mẫu, nghe được
                        // gì ghi nấy. ISE thì ép khớp audio vào câu mẫu nên đọc
                        // ra chữ gì nó cũng cố khớp — đó là lý do một bài đọc ra
                        // 母狼哺乳 thay vì 不冷不热 vẫn được 83 điểm.
                        // Dùng tỉ lệ khớp của IAT làm TRẦN điểm. Xem lib/spokenTextMatch.js.
                        const spokenMatch = computeSpokenMatch(referenceText, spokenText)
                        if (
                            spokenMatch.cap !== null &&
                            typeof score.score === 'number' &&
                            score.score > spokenMatch.cap
                        ) {
                            score.cappedFrom = score.score
                            score.score = spokenMatch.cap
                        }
                        // Ghi nhận riêng việc "có chữ bị nghe ra chữ khác", tách
                        // khỏi việc điểm có bị hạ hay không. Có lần trần bằng
                        // đúng điểm gốc nên không hạ được gì, mà học viên vẫn
                        // cần biết mình đã đọc chệch ba chữ.
                        score.spokenMismatch = spokenMatch.cap !== null

                        // Nhận xét THEO TỪ (không đụng tới điểm số). Gom chữ
                        // thành từ dựa vào phiên âm câu mẫu để dập bớt lỗi báo
                        // oan ở âm tiết thanh nhẹ — xem lib/wordFeedback.js.
                        const wordFeedback = buildWordFeedback(
                            assessment.chars,
                            context.pinyin,
                            referenceText
                        )

                        sendJson({
                            type: 'result',
                            summary: assessment.summary,
                            chars: assessment.chars,
                            spokenText,
                            words: wordFeedback.words,
                            // Vùng ô chữ vốn là MỘT từ ghép nhưng bị phiên âm
                            // tách rời (您 | 好 -> 您好). Học viên cần nghe cả từ
                            // đọc liền, không chỉ từng chữ. Xem compoundWords.js.
                            compounds: wordFeedback.compounds,
                            focusWord: wordFeedback.focusWord,
                            feedback: wordFeedback.feedback,
                            score,
                            spokenMatch,
                        })
                        // Lưu SAU khi đã trả kết quả -> học viên không phải chờ
                        // thao tác ghi đĩa.
                        await savePracticeHistory(pcm, assessment, spokenText, score, wordFeedback, spokenMatch)
                    } catch (err) {
                        // KHÔNG ĐẨY LỖI THÔ CỦA iFLYTEK RA CHO HỌC VIÊN.
                        // Trước đây chuỗi lỗi được chuyển thẳng, nên học viên
                        // nhìn thấy nguyên "ise000760bb@gp1a0a04b08b214a4802
                        // seeRec.SRecWrite error:iSEInputAppend error, ret=8195"
                        // giữa màn hình luyện nói — vừa không hiểu gì, vừa
                        // tưởng máy hỏng nặng. Mã lỗi là thứ CHÚNG TA cần để
                        // chẩn đoán, nên đẩy vào log của máy chủ.
                        const detail = typeof err === 'string' ? err : err?.message || String(err)
                        console.error('[luyện nói] Chấm thất bại:', {
                            referenceText,
                            sentToIse: speakable.text,
                            detail,
                        })
                        sendJson({
                            type: 'error',
                            message: 'Chưa chấm được lần này. Bạn thử ghi âm lại nhé.',
                        })
                    } finally {
                        scoring = false
                        reset() // nhả bộ nhớ ngay, không giữ audio sau khi chấm xong
                    }
                }
                return
            }

            // ----- Frame PCM nhị phân -----
            // Chỉ nhận sau khi đã xác thực và đã 'start'.
            if (!student || !started) return

            const chunk = Buffer.from(data)
            if (audioBytes + chunk.length > MAX_AUDIO_BYTES) {
                fail('Đoạn ghi âm quá dài. Hãy đọc từng câu ngắn thôi nhé.', 4413)
                reset()
                return
            }
            audioChunks.push(chunk)
            audioBytes += chunk.length
        })
    })

    return wss
}

module.exports = { attachPronunciationWs }
