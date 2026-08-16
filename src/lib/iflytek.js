/**
 * Tích hợp iFLYTEK cho gtc-api:
 *   - ISE (Pronunciation Assessment): chấm phát âm, tách riêng điểm thanh điệu.
 *   - IAT (Short Form ASR): nhận diện câu học viên nói ("Nội dung bạn nói").
 *
 * Cả 2 dùng chung cơ chế ký HMAC-SHA256 + WebSocket + audio PCM 16k/16bit/mono.
 * APISecret KHÔNG bao giờ lộ ra client — mọi thứ ký ở backend này.
 *
 * ENV cần có (đặt trong file .env của gtc-api):
 *   XF_APPID, XF_API_KEY, XF_API_SECRET
 */

const crypto = require('crypto')
const WebSocket = require('ws')
const { XMLParser } = require('fast-xml-parser')

const APPID = process.env.XF_APPID || ''
const API_KEY = process.env.XF_API_KEY || ''
const API_SECRET = process.env.XF_API_SECRET || ''

// Cụm Singapore (gần VN). Hai dịch vụ khác nhau ở host + path.
const ISE_HOST = 'ise-api-sg.xf-yun.com'
const ISE_PATH = '/v2/ise'
const IAT_HOST = 'iat-api-sg.xf-yun.com'
const IAT_PATH = '/v2/iat'

// Độ nghiêm khi chấm/bắt lỗi: 'easy' | 'common' | 'hard'.
// HSK sơ cấp nên để 'common' (hoặc 'easy' cho lớp mới); 'hard' quá nghiêm,
// đọc đúng vẫn dễ bị bắt lỗi. Cho phép chỉnh qua ENV mà không sửa code.
const ISE_CHECK_TYPE = process.env.XF_ISE_CHECK_TYPE || 'common'

const DEBUG = process.env.XF_DEBUG === '1'
function dbg(...args) {
    if (DEBUG) console.log('[iflytek]', ...args)
}

// Nhịp gửi từng frame audio lên iFLYTEK (ms). Audio đã thu xong nằm sẵn trong
// buffer khi chấm, nên KHÔNG cần gửi theo nhịp thời gian thực (40ms) như lúc
// thu trực tiếp. Gửi nhanh hơn (10ms) giúp câu dài stream xong sớm hơn nhiều
// lần, giảm mạnh nguy cơ timeout. 10ms vẫn an toàn với ngưỡng nhận của iFLYTEK
// (không nên để 0 vì gửi quá gấp có thể bị báo lỗi tốc độ).
const AUDIO_SEND_INTERVAL_MS = 10

// Kiểm tra đã cấu hình key chưa (dùng để báo lỗi sớm, rõ ràng).
function isConfigured() {
    return Boolean(APPID && API_KEY && API_SECRET)
}

// ---- Ký HMAC-SHA256, dựng URL xác thực (chung cho cả ISE và IAT) ----
function buildAuthUrl(host, path) {
    const date = new Date().toUTCString()
    const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`
    const signatureSha = crypto.createHmac('sha256', API_SECRET).update(signatureOrigin).digest('base64')
    const authorizationOrigin =
        `api_key="${API_KEY}", algorithm="hmac-sha256", ` + `headers="host date request-line", signature="${signatureSha}"`
    const authorization = Buffer.from(authorizationOrigin).toString('base64')
    const params = new URLSearchParams({ authorization, date, host })
    return `wss://${host}${path}?${params.toString()}`
}

// Giải nghĩa lỗi handshake để log cho dễ soi.
function handshakeHint(statusCode) {
    const hints = {
        401: 'Sai/thiếu xác thực. Kiểm tra XF_API_KEY & XF_API_SECRET (đúng app đã bật dịch vụ?), tránh khoảng trắng thừa.',
        403: 'Đồng hồ máy chủ lệch > 5 phút, HOẶC IP whitelist đang bật mà chưa khai IP. Kiểm tra console iFLYTEK.',
        404: 'Sai đường dẫn/endpoint.',
    }
    return hints[statusCode] || ''
}

// =====================================================================
// 1) ISE — CHẤM PHÁT ÂM
// =====================================================================

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })

// Chỉ giữ node thuộc nội dung đề bài. iFLYTEK chèn thêm node nhiễu/im lặng
// (rec_node_type = 'fil' hoặc 'sil') vào giữa các chữ — các node này mang
// dp_message=32 (tăng đọc) NHƯNG KHÔNG phải chữ học viên đọc thừa, mà chỉ là
// tiếng ồn/khoảng lặng. Nếu không lọc, chúng bị gán nhầm "đọc thừa" cho chữ
// Hán bên cạnh (đây chính là bug "今/下 báo đọc thừa oan").
function isPaper(node) {
    return node && node.rec_node_type === 'paper'
}

// Phân loại lỗi của MỘT chữ (word), tách bạch 2 trục:
//   - dp_message (tăng/giảm/lặp/thay thế): {0,16,32,64,128}
//   - perr_msg (sai thanh mẫu/vận mẫu/thanh điệu): {0,1,2,3} kèm is_yun
// Trả về nhãn tiếng Việt cụ thể để học viên biết đường sửa.
// Thuật ngữ Hán ngữ: thanh mẫu (声母), vận mẫu (韵母), thanh điệu (声调).
function classifyWord(w) {
    // Chỉ xét các syll thuộc đề bài (bỏ fil/sil).
    const sylls = [].concat(w.syll || []).filter(isPaper)
    if (sylls.length === 0) return null // chữ chỉ toàn nhiễu -> bỏ khỏi kết quả

    let dpIssue = 0 // mã dp_message nghiêm trọng nhất (16/32/64/128)
    let phoneErr = 0 // mã perr_msg nghiêm trọng nhất (1/2/3)
    let isYun = 0 // 0 = phụ âm đầu (声母), 1 = vần (韵母) — của phone lỗi

    sylls.forEach((sy) => {
        const syDp = parseInt(sy.dp_message ?? '0', 10)
        if ([16, 32, 64, 128].includes(syDp) && syDp > dpIssue) dpIssue = syDp

        const phones = [].concat(sy.phone || []).filter(isPaper)
        phones.forEach((p) => {
            const pe = parseInt(p.perr_msg ?? '0', 10)
            if (pe > 0 && pe > phoneErr) {
                phoneErr = pe
                isYun = parseInt(p.is_yun ?? '0', 10)
            }
            // dp_message cũng có thể xuất hiện ở tầng phone.
            const pDp = parseInt(p.dp_message ?? '0', 10)
            if ([16, 32, 64, 128].includes(pDp) && pDp > dpIssue) dpIssue = pDp
        })
    })

    // Ưu tiên báo lỗi tăng/giảm/thay thế trước (ảnh hưởng lớn hơn),
    // sau đó mới tới lỗi thanh mẫu/vần/thanh điệu.
    let issue = ''
    if (dpIssue === 16) issue = 'đọc thiếu'
    else if (dpIssue === 32) issue = 'đọc thừa'
    else if (dpIssue === 64) issue = 'đọc lặp'
    else if (dpIssue === 128) issue = 'đọc sai (thay thế)'
    // Thuật ngữ Hán ngữ chuẩn (theo yêu cầu khách): 声母 = thanh mẫu (phụ âm
    // đầu), 韵母 = vận mẫu (phần vần), 声调 = thanh điệu (dấu).
    // is_yun: 0 = thanh mẫu, 1 = vận mẫu.
    else if (phoneErr === 2) issue = 'sai thanh điệu'
    else if (phoneErr === 1) issue = isYun === 1 ? 'sai vận mẫu' : 'sai thanh mẫu'
    else if (phoneErr === 3) issue = 'sai âm và thanh điệu'

    return { issue, ok: issue === '' }
}

function parseIseXml(xmlString) {
    const obj = xmlParser.parse(xmlString)
    const xmlResult = obj.xml_result || {}
    const topKey = Object.keys(xmlResult).find((k) => k.startsWith('read_'))
    const top = xmlResult[topKey]
    const paper = top?.rec_paper?.[topKey] || top?.rec_paper || top

    const num = (v) => (v === undefined ? null : Math.round(parseFloat(v) * 100) / 100)

    const summary = {
        total_score: num(paper?.total_score),
        phone_score: num(paper?.phone_score), // phát âm (thanh mẫu/vận mẫu)
        tone_score: num(paper?.tone_score), // ĐIỂM THANH ĐIỆU
        fluency_score: num(paper?.fluency_score),
        integrity_score: num(paper?.integrity_score),
        is_rejected: paper?.is_rejected === 'true',
        except_info: paper?.except_info || null,
    }

    const chars = []
    const collectWords = (node) => {
        if (!node) return
        const sentences = [].concat(node.sentence || [])
        sentences.forEach((s) => {
            const words = [].concat(s.word || [])
            words.forEach((w) => {
                // Bỏ chữ không có nội dung, hoặc bản thân là nhiễu/im lặng.
                if (!w.content || w.content === 'sil' || w.content === 'fil') return
                const cls = classifyWord(w)
                if (!cls) return // chữ chỉ toàn nhiễu (không có syll 'paper')
                chars.push({
                    content: w.content,
                    pinyin: w.symbol || '',
                    issue: cls.issue,
                    ok: cls.ok,
                })
            })
        })
    }
    collectWords(paper)

    return { summary, chars }
}

// Stream 1 buffer PCM tới ISE, gọi onResult / onError.
function runIse(pcmBuffer, text, onResult, onError) {
    const url = buildAuthUrl(ISE_HOST, ISE_PATH)
    const ws = new WebSocket(url)
    let xmlChunks = ''

    ws.on('unexpected-response', (req, res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
            const msg = `ISE handshake HTTP ${res.statusCode} — ${body || '(rỗng)'} ${handshakeHint(res.statusCode)}`
            console.error('[iflytek ISE handshake]', msg)
            onError(msg)
        })
    })

    ws.on('open', () => {
        const business = {
            category: 'read_sentence',
            rstcd: 'utf8',
            sub: 'ise',
            group: 'adult',
            ent: 'cn_vip',
            tte: 'utf-8',
            cmd: 'ssb',
            auf: 'audio/L16;rate=16000',
            aue: 'raw',
            text: '\uFEFF' + text, // BẮT BUỘC có BOM
            ttp_skip: true,
            ise_unite: '1',
            extra_ability: 'multi_dimension;syll_phone_err_msg',
            check_type: ISE_CHECK_TYPE, // 'common' cho HSK sơ cấp (đổi qua ENV)
        }
        ws.send(JSON.stringify({ common: { app_id: APPID }, business, data: { status: 0 } }))

        const FRAME = 1280
        let offset = 0
        let firstAudio = true
        const timer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                clearInterval(timer)
                return
            }
            const end = Math.min(offset + FRAME, pcmBuffer.length)
            const slice = pcmBuffer.slice(offset, end)
            const isLast = end >= pcmBuffer.length
            ws.send(
                JSON.stringify({
                    business: { cmd: 'auw', aus: firstAudio ? 1 : isLast ? 4 : 2 },
                    data: { status: isLast ? 2 : 1, data: slice.toString('base64') },
                })
            )
            firstAudio = false
            offset = end
            if (isLast) clearInterval(timer)
        }, AUDIO_SEND_INTERVAL_MS)
    })

    ws.on('message', (raw) => {
        let msg
        try {
            msg = JSON.parse(raw.toString())
        } catch {
            return
        }
        if (msg.code !== 0) {
            onError(`ISE mã lỗi ${msg.code}: ${msg.message}`)
            ws.close()
            return
        }
        if (msg.data && msg.data.data) {
            xmlChunks += Buffer.from(msg.data.data, 'base64').toString('utf-8')
        }
        if (msg.data && msg.data.status === 2) {
            try {
                onResult(parseIseXml(xmlChunks))
            } catch (e) {
                onError('Không parse được XML ISE: ' + e.message)
            }
            ws.close()
        }
    })

    ws.on('error', (e) => {
        console.error('[iflytek ISE ws error]', e.message)
        onError('WebSocket ISE lỗi: ' + e.message)
    })
}

// =====================================================================
// 2) IAT — NHẬN DIỆN "NỘI DUNG BẠN NÓI"
// =====================================================================

function runIat(pcmBuffer, onResult, onError) {
    const url = buildAuthUrl(IAT_HOST, IAT_PATH)
    const ws = new WebSocket(url)
    // IAT trả kết quả theo nhiều mảnh (sn tăng dần). Gom theo thứ tự sn.
    const pieces = []

    ws.on('unexpected-response', (req, res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
            const msg = `IAT handshake HTTP ${res.statusCode} — ${body || '(rỗng)'} ${handshakeHint(res.statusCode)}`
            console.error('[iflytek IAT handshake]', msg)
            onError(msg)
        })
    })

    ws.on('open', () => {
        const business = {
            language: 'zh_cn',
            domain: 'iat',
            accent: 'mandarin',
            vad_eos: 3000,
            ptt: 0, // không tự thêm dấu câu — chỉ cần chữ để so với câu mẫu
        }
        ws.send(
            JSON.stringify({
                common: { app_id: APPID },
                business,
                data: {
                    status: 0,
                    format: 'audio/L16;rate=16000',
                    encoding: 'raw',
                    audio: '',
                },
            })
        )

        const FRAME = 1280
        let offset = 0
        const timer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                clearInterval(timer)
                return
            }
            const end = Math.min(offset + FRAME, pcmBuffer.length)
            const slice = pcmBuffer.slice(offset, end)
            const isLast = end >= pcmBuffer.length
            ws.send(
                JSON.stringify({
                    data: {
                        status: isLast ? 2 : 1,
                        format: 'audio/L16;rate=16000',
                        encoding: 'raw',
                        audio: slice.toString('base64'),
                    },
                })
            )
            offset = end
            if (isLast) clearInterval(timer)
        }, AUDIO_SEND_INTERVAL_MS)
    })

    ws.on('message', (raw) => {
        let msg
        try {
            msg = JSON.parse(raw.toString())
        } catch {
            return
        }
        if (msg.code !== 0) {
            onError(`IAT mã lỗi ${msg.code}: ${msg.message}`)
            ws.close()
            return
        }
        const result = msg.data && msg.data.result
        if (result && Array.isArray(result.ws)) {
            let text = ''
            result.ws.forEach((seg) => {
                ; (seg.cw || []).forEach((c) => (text += c.w || ''))
            })
            // sn = số thứ tự mảnh; lưu theo index để ghép đúng thứ tự.
            pieces[result.sn || pieces.length] = text
        }
        if (msg.data && msg.data.status === 2) {
            onResult(pieces.join('').trim())
            ws.close()
        }
    })

    ws.on('error', (e) => {
        console.error('[iflytek IAT ws error]', e.message)
        onError('WebSocket IAT lỗi: ' + e.message)
    })
}

// =====================================================================
// 3) API tiện dụng: chạy song song ISE + IAT trên cùng 1 buffer PCM
// =====================================================================

// Trả về Promise<{ assessment, spokenText }>.
// - assessment: { summary, chars } từ ISE (bắt buộc — lỗi thì reject).
// - spokenText: câu học viên nói từ IAT (không bắt buộc — lỗi thì trả '').
function assessAndRecognize(pcmBuffer, referenceText) {
    const isePromise = new Promise((resolve, reject) => {
        runIse(
            pcmBuffer,
            referenceText,
            (result) => resolve(result),
            (err) => reject(err)
        )
    })

    const iatPromise = new Promise((resolve) => {
        // IAT không được làm hỏng luồng chính: lỗi -> trả ''.
        runIat(
            pcmBuffer,
            (text) => resolve(text || ''),
            () => resolve('')
        )
    })

    return isePromise.then(async (assessment) => {
        // Chờ IAT tối đa 4s; quá thì bỏ qua, "Nội dung bạn nói" rỗng.
        const spokenText = await Promise.race([
            iatPromise,
            new Promise((r) => setTimeout(() => r(''), 4000)),
        ])
        return { assessment, spokenText }
    })
}

module.exports = { isConfigured, assessAndRecognize }