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
const ISE_CHECK_TYPE = process.env.XF_ISE_CHECK_TYPE || 'hard'

const DEBUG = process.env.XF_DEBUG === '1'
function dbg(...args) {
    if (DEBUG) console.log('[iflytek]', ...args)
}

// Nhịp và kích thước frame khi đẩy audio lên iFLYTEK.
//
// Tài liệu quy định: "1280B mỗi 40ms, kích thước có thể điều chỉnh", trần
// 19.200B/frame. Audio đã thu xong nằm sẵn trong buffer nên ta muốn gửi nhanh
// hơn thời gian thực để câu dài không bị timeout.
//
// BẢN CŨ gửi 1280B mỗi 10ms — nhanh gấp 4 lần, nhưng bằng cách RÚT NGẮN NHỊP,
// tức là chạy ngoài vùng tài liệu bảo đảm và có nguy cơ bị chặn tốc độ. Cách
// đúng để tăng tốc là GIỮ NHỊP 40ms và TĂNG KÍCH THƯỚC FRAME. 5120B/40ms cho
// đúng tốc độ gấp 4 như cũ, mà vẫn nằm trọn trong quy định.
const AUDIO_SEND_INTERVAL_MS = 40
const AUDIO_FRAME_BYTES = 5120 // 4 x 1280, trần cho phép là 19200

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

// Ghép nhãn lỗi tiếng Việt từ các trục lỗi đã phát hiện.
function joinIssues(parts) {
    if (parts.length === 0) return ''
    if (parts.length === 1) return `sai ${parts[0]}`
    if (parts.length === 2) return `sai ${parts[0]} và ${parts[1]}`
    return `sai ${parts.slice(0, -1).join(', ')} và ${parts[parts.length - 1]}`
}

// Phone giả của âm tiết ZERO THANH MẪU.
//
// Quan sát từ XML thật (24/08/2026): iFLYTEK biểu diễn âm tiết không có thanh
// mẫu bằng một phone có dấu gạch dưới ở đầu, và gán cho nó is_yun="0":
//
//   卫 wèi  -> <phone content="_u"  is_yun="0" .../>
//   样 yàng -> <phone content="_i"  is_yun="0" .../>
//
// Nhưng `_u` và `_i` KHÔNG phải thanh mẫu — chúng là GIỚI ÂM (介音), mà trong
// âm vận học Hán ngữ giới âm là 韵头, thuộc về VẬN MẪU. is_yun=0 ở đây là quy
// ước nội bộ của iFLYTEK chứ không phải phân loại ngôn ngữ học.
//
// Đây chính là nguồn của nhãn "sai thanh mẫu" gán cho 哦 (ō) — một âm tiết
// không hề có thanh mẫu, nên nhãn đó bất khả thi. Coi các phone này là vận mẫu.
function isZeroInitialPlaceholder(phone) {
    return typeof phone.content === 'string' && phone.content.startsWith('_')
}

/**
 * Phân loại lỗi của MỘT chữ (word).
 *
 * ĐỌC TÀI LIỆU iFLYTEK TRƯỚC KHI SỬA HÀM NÀY:
 *   perr_msg = 0  đúng
 *   perr_msg = 1  sai thanh mẫu (nếu is_yun=0) HOẶC sai vận mẫu (nếu is_yun=1)
 *   perr_msg = 2  sai thanh điệu — CHỈ xuất hiện khi is_yun=1
 *   perr_msg = 3  sai CẢ vận mẫu LẪN thanh điệu — CHỈ khi is_yun=1
 *   is_yun   = 0  thanh mẫu (声母)  |  1  vận mẫu (韵母)
 *
 * BẢN CŨ SAI Ở ĐÂY: nó lấy perr_msg LỚN NHẤT trong các phone rồi chỉ báo một
 * lỗi. Nhưng perr_msg là MÃ PHÂN LOẠI, không phải thang mức độ. Kiểm chứng trên
 * XML thật:
 *
 *   好 = phone h (is_yun=0, perr_msg=1) + phone ao (is_yun=1, perr_msg=3)
 *        cũ: lấy max=3 -> "sai âm và thanh điệu", NUỐT MẤT lỗi thanh mẫu
 *        mới: "sai thanh mẫu, vận mẫu và thanh điệu"
 *
 *   字 = phone z (is_yun=0, perr_msg=1) + phone ii (is_yun=1, perr_msg=1)
 *        cũ: hai giá trị bằng nhau, `>` không thoả ở phone sau -> giữ phone
 *            ĐẦU TIÊN -> "sai thanh mẫu", nhãn phụ thuộc thứ tự XML
 *        mới: "sai thanh mẫu và vận mẫu"
 *
 * BẢN NÀY xét TỪNG phone độc lập rồi gom thành tập hợp các trục lỗi.
 */
function classifyWord(w) {
    // Chỉ xét các syll thuộc đề bài (bỏ fil/sil).
    const sylls = [].concat(w.syll || []).filter(isPaper)
    if (sylls.length === 0) return null // chữ chỉ toàn nhiễu -> bỏ khỏi kết quả

    // Vị trí của chữ này TRONG BẢN GHI ÂM, tính bằng mili giây.
    //
    // Tài liệu: beg_pos/end_pos tính theo KHUNG HÌNH, mỗi khung 10ms. Đã kiểm
    // trên file thật: end_pos cao nhất x 10ms = 3280ms so với file dài 3304ms,
    // lệch 24ms — tức là mốc thời gian khớp với audio.
    //
    // LẤY TỪ TẦNG syll CHỨ KHÔNG PHẢI tầng word: node word BAO GỒM cả khoảng
    // lặng/nhiễu đứng trước nó. Ví dụ thật, chữ 大:
    //   <word beg_pos="0" end_pos="188">        <- gồm cả 1,51 giây im lặng
    //     <syll content="sil" beg_pos="0"   end_pos="151"/>
    //     <syll content="大"  beg_pos="151" end_pos="188"/>   <- tiếng thật ở đây
    // Dùng mốc của word thì cắt ra toàn khoảng lặng.
    const begs = sylls.map((sy) => parseInt(sy.beg_pos ?? '-1', 10)).filter((v) => v >= 0)
    const ends = sylls.map((sy) => parseInt(sy.end_pos ?? '-1', 10)).filter((v) => v >= 0)
    const begMs = begs.length > 0 ? Math.min(...begs) * 10 : null
    const endMs = ends.length > 0 ? Math.max(...ends) * 10 : null

    let dpIssue = 0

    // GHI CHÚ TRUNG THỰC: hai nguồn tín hiệu dưới đây được thêm vào theo tài
    // liệu, nhưng kiểm tra XML thật (24/08/2026, category=read_sentence,
    // ent=cn_vip) thì KHÔNG THẤY XUẤT HIỆN:
    //   - dp_message ở tầng `word`  (chỉ thấy ở tầng syll và phone)
    //   - serr_msg   ở tầng `syll`  (không thấy ở đâu cả)
    // Giữ lại làm lưới an toàn phòng khi iFLYTEK đổi định dạng hoặc khi dùng
    // category khác. Đừng trông cậy vào chúng, và đừng tưởng chúng đang chạy.
    const wDp = parseInt(w.dp_message ?? '0', 10)
    if ([16, 32, 64, 128].includes(wDp)) dpIssue = wDp

    let initialWrong = false // sai thanh mẫu
    let finalWrong = false // sai vận mẫu
    let toneWrong = false // sai thanh điệu
    let unknownPhoneErr = false // có lỗi nhưng không xác định được thuộc trục nào
    let syllErr = false // serr_msg báo âm tiết đọc sai (chưa quan sát thấy)

    // perr_level_msg: KHÔNG CÓ TRONG TÀI LIỆU, nhưng xuất hiện trên mọi phone
    // của XML thật với giá trị 1-3. Quan sát cho thấy đây là thang MỨC ĐỘ, độc
    // lập với perr_msg:
    //   1 = tốt   2 = tạm/hơi lệch   3 = kém rõ rệt
    // Bằng chứng nó độc lập: chữ 叫 và 么 có perr_msg=0 (không lỗi) nhưng
    // perr_level_msg=2; chữ 大 có perr_msg=2 (sai thanh) nhưng level=1.
    //
    // CHỈ dùng để phân biệt lỗi RÕ RỆT với lỗi BIÊN — vd. 卫 sai vận mẫu ở mức
    // 2 (hơi lệch) trong khi 好 sai ở mức 3 (sai hẳn).
    //
    // TUYỆT ĐỐI KHÔNG dùng nó để tự tuyên bố lỗi mới. Đã từng cho phone sạch có
    // perr_level_msg=2 hiện màu vàng, và hậu quả là một bài đọc mà iFLYTEK chấm
    // phone_score=100, tone_score=100, KHÔNG một perr_msg nào khác 0 — vẫn hiện
    // 2 từ vàng kèm thẻ "Phát âm chưa đúng" với điểm 100. Tự chế ra lỗi mà máy
    // chấm không hề báo, đúng thứ khách hàng phàn nàn suốt là "báo lỗi oan".
    //
    // Nguyên tắc: chữ nào iFLYTEK bảo ĐÚNG thì hiển thị là ĐÚNG. Hết.
    let errorLevel = 0 // mức của phone lỗi nặng nhất
    let maxCleanLevel = 1 // chỉ ghi lại để chẩn đoán, KHÔNG dùng để tô màu

    sylls.forEach((sy) => {
        const syDp = parseInt(sy.dp_message ?? '0', 10)
        if ([16, 32, 64, 128].includes(syDp) && syDp > dpIssue) dpIssue = syDp

        const se = parseInt(sy.serr_msg ?? '0', 10)
        if (se === 1 || se === 2049) syllErr = true

        const phones = [].concat(sy.phone || []).filter(isPaper)
        phones.forEach((p) => {
            const pDp = parseInt(p.dp_message ?? '0', 10)
            if ([16, 32, 64, 128].includes(pDp) && pDp > dpIssue) dpIssue = pDp

            const level = parseInt(p.perr_level_msg ?? '1', 10) || 1
            const pe = parseInt(p.perr_msg ?? '0', 10)

            if (!pe) {
                if (level > maxCleanLevel) maxCleanLevel = level
                return
            }
            if (level > errorLevel) errorLevel = level

            // Suy ra is_yun. Tài liệu khẳng định perr_msg 2 và 3 CHỈ tồn tại ở
            // phone vận mẫu, nên với hai mã đó ta biết chắc is_yun=1 mà không
            // cần đọc thuộc tính.
            let isYun = null
            if (pe === 2 || pe === 3) isYun = 1
            else if (isZeroInitialPlaceholder(p)) isYun = 1 // phone giả `_x` -> giới âm, thuộc vận mẫu
            else if (p.is_yun !== undefined && p.is_yun !== null) isYun = parseInt(p.is_yun, 10)

            if (pe === 1) {
                if (isYun === 0) initialWrong = true
                else if (isYun === 1) finalWrong = true
                else unknownPhoneErr = true // thiếu is_yun -> không đoán bừa
            } else if (pe === 2) {
                toneWrong = true
            } else if (pe === 3) {
                finalWrong = true
                toneWrong = true
            } else {
                unknownPhoneErr = true
            }
        })
    })

    // Ưu tiên báo lỗi tăng/giảm/thay thế trước (ảnh hưởng lớn hơn), sau đó mới
    // tới lỗi thanh mẫu/vận mẫu/thanh điệu.
    // Thuật ngữ Hán ngữ: 声母 = thanh mẫu, 韵母 = vận mẫu, 声调 = thanh điệu.
    let issue = ''
    if (dpIssue === 16) issue = 'đọc thiếu'
    else if (dpIssue === 32) issue = 'đọc thừa'
    else if (dpIssue === 64) issue = 'đọc lặp'
    else if (dpIssue === 128) issue = 'đọc sai (thay thế)'
    else {
        const parts = []
        if (initialWrong) parts.push('thanh mẫu')
        if (finalWrong) parts.push('vận mẫu')
        if (toneWrong) parts.push('thanh điệu')
        issue = joinIssues(parts)
        if (!issue && (unknownPhoneErr || syllErr)) issue = 'phát âm chưa chuẩn'
    }

    const hasError = issue !== ''

    // Quy về ba mức hiển thị: 'good' | 'fair' | 'weak'.
    //
    // LỖI THANH ĐIỆU LUÔN LÀ 'weak'. Lý do:
    // perr_level_msg chấm chất lượng ÂM ĐOẠN, không chấm thanh điệu — bằng
    // chứng: qua 3 file XML thật, mọi lỗi thanh điệu thuần tuý (perr_msg=2)
    // đều đi kèm perr_level_msg là 1 hoặc 2, chưa lần nào là 3. Nghĩa là ta
    // KHÔNG CÓ thông tin mức độ cho lỗi thanh. Mà trong tiếng Trung, sai thanh
    // điệu là thành một chữ khác hẳn (妈/麻/马/骂), nên không có dữ liệu thì
    // phải mặc định coi là nặng, chứ không phải coi là nhẹ.
    //
    // Đọc thiếu và đọc sai (thay thế) cũng luôn 'weak'. Đọc thừa/đọc lặp chỉ là
    // lỗi nhịp, không phải lỗi phát âm -> 'fair'.
    //
    // Giữ nguyên nguyên tắc: chữ nào iFLYTEK bảo ĐÚNG thì cao nhất chỉ tới
    // 'fair', không bao giờ thành 'weak' — ta không tự tạo ra lỗi mới.
    let level
    if (!hasError) {
        level = 'good' // iFLYTEK bảo đúng -> hiển thị là đúng, không bàn thêm
    } else if (dpIssue === 32 || dpIssue === 64) {
        level = 'fair' // đọc thừa / đọc lặp: sai nhịp, không sai âm
    } else if (toneWrong || dpIssue === 16 || dpIssue === 128) {
        level = 'weak'
    } else {
        level = errorLevel >= 3 ? 'weak' : 'fair'
    }

    return {
        issue,
        ok: !hasError,
        level,
        begMs, // vị trí chữ này trong bản ghi âm của học viên
        endMs,
        detail: {
            initial: initialWrong,
            final: finalWrong,
            tone: toneWrong,
            dp: dpIssue,
            errorLevel, // 0 nếu không có lỗi
            maxCleanLevel, // chỉ để chẩn đoán, không ảnh hưởng hiển thị
            unknown: unknownPhoneErr || (syllErr && !initialWrong && !finalWrong && !toneWrong),
        },
    }
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
                    level: cls.level,
                    begMs: cls.begMs,
                    endMs: cls.endMs,
                    detail: cls.detail,
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

        const FRAME = AUDIO_FRAME_BYTES
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
            // aus: 1 = frame đầu, 2 = frame giữa, 4 = frame cuối (theo tài liệu).
            // Nếu audio ngắn tới mức chỉ có ĐÚNG MỘT frame thì nó vừa là đầu vừa
            // là cuối; ta ưu tiên aus=1, còn tín hiệu kết thúc do data.status=2
            // đảm nhiệm. Trên thực tế không xảy ra: một frame chỉ chứa 160ms
            // audio, mà câu ngắn nhất cũng vài giây.
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
            dbg('XML ISE trả về:\n' + xmlChunks)
            try {
                // Trả kèm XML THÔ. Đây là nguồn sự thật duy nhất khi cần đối
                // chứng "vì sao chữ này bị báo lỗi kiểu đó" — mọi kết luận về
                // nhãn lỗi mà không có XML thô đều chỉ là suy đoán.
                onResult({ ...parseIseXml(xmlChunks), rawXml: xmlChunks })
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

        const FRAME = AUDIO_FRAME_BYTES
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