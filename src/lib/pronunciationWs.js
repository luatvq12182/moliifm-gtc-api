/**
 * WebSocket server cho chấm phát âm iFLYTEK, gắn vào HTTP server của gtc-api.
 *
 * Luồng:
 *   client mở WS -> gửi {type:'start', text} -> gửi các frame PCM (binary)
 *   -> gửi {type:'end'} -> server stream tới iFLYTEK (ISE + IAT) -> trả
 *   {type:'result', summary, chars, spokenText} hoặc {type:'error', message}.
 *
 * Gắn vào server trong server.js:
 *   const { attachPronunciationWs } = require('./pronunciationWs')
 *   const server = http.createServer(app)
 *   attachPronunciationWs(server)
 *   server.listen(PORT)
 */

const WebSocket = require('ws')
const { isConfigured, assessAndRecognize } = require('./iflytek')

function attachPronunciationWs(httpServer, path = '/ws/pronunciation') {
    // noServer: tự xử lý 'upgrade' để chỉ nhận đúng path này, tránh đụng các
    // WS khác (nếu có) và để Nginx proxy dễ.
    const wss = new WebSocket.Server({ noServer: true })

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

    wss.on('connection', (client) => {
        let audioChunks = []
        let referenceText = ''
        let started = false

        const sendJson = (obj) => {
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj))
        }

        if (!isConfigured()) {
            sendJson({
                type: 'error',
                message: 'Máy chủ chưa cấu hình khóa iFLYTEK (XF_APPID/XF_API_KEY/XF_API_SECRET).',
            })
        }

        client.on('message', (data, isBinary) => {
            if (!isBinary) {
                let m
                try {
                    m = JSON.parse(data.toString())
                } catch {
                    return
                }
                if (m.type === 'start') {
                    audioChunks = []
                    referenceText = (m.text || '').trim()
                    started = true
                } else if (m.type === 'end') {
                    if (!started) {
                        sendJson({ type: 'error', message: 'Chưa bắt đầu ghi âm.' })
                        return
                    }
                    const pcm = Buffer.concat(audioChunks)
                    if (pcm.length === 0) {
                        sendJson({ type: 'error', message: 'Không nghe thấy bạn nói gì cả. Bấm mic rồi đọc to, rõ ràng nhé.' })
                        return
                    }
                    if (!referenceText) {
                        sendJson({ type: 'error', message: 'Thiếu câu mẫu để chấm.' })
                        return
                    }
                    assessAndRecognize(pcm, referenceText)
                        .then(({ assessment, spokenText }) => {
                            sendJson({
                                type: 'result',
                                summary: assessment.summary,
                                chars: assessment.chars,
                                spokenText,
                            })
                        })
                        .catch((err) => {
                            sendJson({ type: 'error', message: typeof err === 'string' ? err : 'Lỗi khi chấm phát âm.' })
                        })
                }
            } else {
                // Frame PCM nhị phân.
                audioChunks.push(Buffer.from(data))
            }
        })
    })

    return wss
}

module.exports = { attachPronunciationWs }