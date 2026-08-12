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

const DEBUG = process.env.XF_DEBUG === '1'
function dbg(...args) {
    if (DEBUG) console.log('[iflytek]', ...args)
}

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

    // Mã trạng thái đọc từng chữ.
    const codeMap = {
        0: '',
        1: 'sai âm',
        2: 'sai thanh điệu',
        3: 'sai cả âm và thanh điệu',
        16: 'đọc thiếu',
        32: 'đọc thừa',
        64: 'đọc lặp',
        128: 'đọc sai',
    }

    const chars = []
    const collectWords = (node) => {
        if (!node) return
        const sentences = [].concat(node.sentence || [])
        sentences.forEach((s) => {
            const words = [].concat(s.word || [])
            words.forEach((w) => {
                const sylls = [].concat(w.syll || [])
                let worst = 0
                sylls.forEach((sy) => {
                    const syDp = parseInt(sy.dp_message ?? '0', 10)
                    if (syDp > worst) worst = syDp
                    const phones = [].concat(sy.phone || [])
                    phones.forEach((p) => {
                        const pv = parseInt(p.perr_msg ?? '0', 10)
                        if (pv > worst) worst = pv
                        const pDp = parseInt(p.dp_message ?? '0', 10)
                        if (pDp > worst) worst = pDp
                    })
                })
                if (!w.content || w.content === 'sil' || w.content === 'fil') return
                chars.push({
                    content: w.content,
                    pinyin: w.symbol || '',
                    issue: codeMap[worst] ?? '',
                    ok: worst === 0,
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
            group: 'adult', // FIX cứng theo yêu cầu
            ent: 'cn_vip',
            tte: 'utf-8',
            cmd: 'ssb',
            auf: 'audio/L16;rate=16000',
            aue: 'raw',
            text: '\uFEFF' + text, // BẮT BUỘC có BOM
            ttp_skip: true,
            ise_unite: '1',
            extra_ability: 'multi_dimension;syll_phone_err_msg',
            check_type: 'hard', // FIX cứng theo yêu cầu
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
        }, 40)
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
        }, 40)
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