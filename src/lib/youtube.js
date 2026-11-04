const fs = require('fs')
const path = require('path')
const { MATERIALS_DIR } = require('./materialConvert')

/**
 * Đọc thông tin video YouTube cho "Video bài giảng" — không cần khoá API:
 *
 *  - Tên video: oEmbed của YouTube. Chạy được với video Công khai và Không
 *    công khai; video Riêng tư / đã xoá / sai mã trả lỗi -> báo admin.
 *  - Thời lượng: đọc "lengthSeconds" trong trang xem video. YouTube hay chặn
 *    máy chủ bằng màn "xác nhận không phải robot" -> thường KHÔNG đọc được;
 *    khi đó trình phát báo về (admin bấm Xem trước, hoặc học viên xem lần đầu).
 *  - Ảnh bìa: lưu MỘT LẦN về máy chủ, học viên lấy qua route có kiểm quyền,
 *    để danh sách video không lộ mã YouTube.
 *
 * Địa chỉ gốc đổi được qua biến môi trường để bài kiểm tra dùng máy chủ giả.
 */

const oembedBase = () => process.env.YOUTUBE_OEMBED_BASE || 'https://www.youtube.com/oembed'
const watchBase = () => process.env.YOUTUBE_WATCH_BASE || 'https://www.youtube.com/watch'
const thumbBase = () => process.env.YOUTUBE_THUMB_BASE || 'https://i.ytimg.com/vi'

const VIDEOS_DIR = path.join(MATERIALS_DIR, 'videos')
const ID_RE = /^[a-zA-Z0-9_-]{11}$/

const VIDEO_ACCESS_HINT =
    'Không đọc được video này trên YouTube. Kiểm tra lại link, và đặt chế độ hiển thị của video là ' +
    '"Không công khai" (không chọn "Riêng tư"), cho phép nhúng video.'

/**
 * Mã video (11 ký tự) từ mọi kiểu link YouTube hay gặp, hoặc null:
 *   youtube.com/watch?v=ID · youtu.be/ID · youtube.com/embed/ID ·
 *   youtube.com/shorts/ID · youtube.com/live/ID · m.youtube.com · music.youtube.com
 */
function parseYouTubeId(input) {
    const raw = String(input || '').trim()
    if (ID_RE.test(raw)) return raw
    let url
    try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    } catch {
        return null
    }
    const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
    let id = null
    if (host === 'youtu.be') id = url.pathname.split('/')[1]
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        if (url.pathname === '/watch') id = url.searchParams.get('v')
        else {
            const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/)
            if (m) id = m[1]
        }
    }
    return id && ID_RE.test(id) ? id : null
}

/** Tên + thời lượng (giây, 0 nếu không đọc được). Ném lỗi khi video không xem được. */
async function fetchYouTubeInfo(id) {
    let res
    try {
        const watchUrl = `https://www.youtube.com/watch?v=${id}`
        res = await fetch(`${oembedBase()}?url=${encodeURIComponent(watchUrl)}&format=json`, {
            signal: AbortSignal.timeout(15000),
        })
    } catch {
        throw new Error('Máy chủ không kết nối được YouTube. Thử lại sau ít phút.')
    }
    if (!res.ok) throw new Error(VIDEO_ACCESS_HINT)
    const info = await res.json().catch(() => null)
    if (!info || !info.title) throw new Error(VIDEO_ACCESS_HINT)

    let durationSec = 0
    try {
        const page = await fetch(`${watchBase()}?v=${id}`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'vi,en;q=0.8' },
            signal: AbortSignal.timeout(15000),
        })
        const m = (await page.text()).match(/"lengthSeconds":"(\d+)"/)
        if (m) durationSec = Number(m[1]) || 0
    } catch {
        // bỏ qua — có trình phát báo về sau
    }
    return { title: String(info.title).trim().slice(0, 200), durationSec }
}

const thumbPath = (videoDocId) => path.join(VIDEOS_DIR, `${videoDocId}.jpg`)

/** Lưu ảnh bìa YouTube về máy chủ. Trả tên file, hoặc '' nếu không lấy được. */
async function saveYouTubeThumb(videoDocId, youtubeId) {
    // Ảnh lớn không phải video nào cũng có -> lùi về ảnh 480x360 luôn có.
    for (const name of ['maxresdefault.jpg', 'hqdefault.jpg']) {
        try {
            const res = await fetch(`${thumbBase()}/${youtubeId}/${name}`, { signal: AbortSignal.timeout(15000) })
            if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) continue
            const buf = Buffer.from(await res.arrayBuffer())
            if (buf.length < 1500) continue // ảnh xám "không có ảnh" của YouTube
            await fs.promises.mkdir(VIDEOS_DIR, { recursive: true })
            await fs.promises.writeFile(thumbPath(videoDocId), buf)
            return path.basename(thumbPath(videoDocId))
        } catch {
            // thử cỡ tiếp theo
        }
    }
    return ''
}

async function removeVideoThumb(videoDocId) {
    await fs.promises.rm(thumbPath(videoDocId), { force: true }).catch(() => { })
}

/** Gửi ảnh bìa đã lưu (riêng tư, không cache chung). */
function sendVideoThumb(res, video) {
    if (!video.thumbFile) {
        res.status(404)
        throw new Error('Video chưa có ảnh bìa.')
    }
    const abs = thumbPath(video._id)
    if (!fs.existsSync(abs)) {
        res.status(404)
        throw new Error('Video chưa có ảnh bìa.')
    }
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    fs.createReadStream(abs).pipe(res)
}

module.exports = {
    parseYouTubeId,
    fetchYouTubeInfo,
    saveYouTubeThumb,
    removeVideoThumb,
    sendVideoThumb,
    VIDEO_ACCESS_HINT,
}
