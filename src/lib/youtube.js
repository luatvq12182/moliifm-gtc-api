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
const playlistBase = () => process.env.YOUTUBE_PLAYLIST_BASE || 'https://www.youtube.com/playlist'

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

// ---------- danh sách phát ----------

const LIST_RE = /^[A-Za-z0-9_-]{10,64}$/
const timeToSec = (t) => (/^\d{1,2}(:\d{2}){1,2}$/.test(String(t || '')) ? String(t).split(':').reduce((a, x) => a * 60 + Number(x), 0) : 0)
const UNAVAILABLE_TITLE = /^\[(private video|deleted video|video riêng tư|video đã bị xoá|video đã bị xóa)\]$/i

/**
 * Mã danh sách phát từ link YouTube (youtube.com/playlist?list=…, hoặc link
 * một video có kèm &list=…), hoặc null. Bỏ qua danh sách riêng của tài khoản
 * (WL = Xem sau, LL = Video đã thích) — không mở được từ máy chủ.
 */
function parsePlaylistId(input) {
    const raw = String(input || '').trim()
    let url
    try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    } catch {
        return null
    }
    const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
    if (host !== 'youtube.com' && host !== 'youtu.be') return null
    const id = url.searchParams.get('list')
    return id && LIST_RE.test(id) && !['WL', 'LL'].includes(id) ? id : null
}

/**
 * Đọc danh sách phát CÔNG KHAI / KHÔNG CÔNG KHAI từ trang của YouTube (không cần
 * khoá API). Trả { title, items: [{ id, title, durationSec, unavailable }], hasMore }.
 * Trang đầu của YouTube có tối đa ~100 video; `hasMore` = danh sách dài hơn thế.
 */
async function fetchPlaylist(listId) {
    let res
    try {
        res = await fetch(`${playlistBase()}?list=${encodeURIComponent(listId)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
                'Accept-Language': 'vi,en;q=0.8',
            },
            signal: AbortSignal.timeout(20000),
        })
    } catch {
        throw new Error('Máy chủ không kết nối được YouTube. Thử lại sau ít phút.')
    }
    const html = res.ok ? await res.text() : ''
    const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)
    let data = null
    try {
        data = m ? JSON.parse(m[1]) : null
    } catch {
        data = null
    }
    if (!data) throw new Error('Không đọc được danh sách phát. Kiểm tra lại link, và đặt danh sách phát là "Công khai" hoặc "Không công khai".')

    const items = []
    const seen = new Set()
    const push = (id, title, durationSec, unavailable) => {
        if (!id || !ID_RE.test(id) || seen.has(id)) return
        seen.add(id)
        title = String(title || '').trim()
        items.push({ id, title, durationSec, unavailable: Boolean(unavailable || UNAVAILABLE_TITLE.test(title)) })
    }
    const textOf = (t) => t?.simpleText || (t?.runs || []).map((r) => r.text).join('') || t?.content || ''
    const findBadge = (o) => {
        let found = 0
        ;(function walk(x) {
            if (found || !x || typeof x !== 'object') return
            if (x.thumbnailBadgeViewModel && timeToSec(x.thumbnailBadgeViewModel.text)) found = timeToSec(x.thumbnailBadgeViewModel.text)
            for (const k in x) walk(x[k])
        })(o)
        return found
    }
    ;(function walk(o) {
        if (!o || typeof o !== 'object') return
        // Hai kiểu trang YouTube đang dùng: kiểu cũ (playlistVideoRenderer) và mới (lockupViewModel).
        if (o.playlistVideoRenderer) {
            const v = o.playlistVideoRenderer
            return push(v.videoId, textOf(v.title), Number(v.lengthSeconds) || 0, v.isPlayable === false)
        }
        if (o.lockupViewModel && o.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
            const v = o.lockupViewModel
            return push(v.contentId, v.metadata?.lockupMetadataViewModel?.title?.content, findBadge(v.contentImage), false)
        }
        for (const k in o) walk(o[k])
    })(data.contents || data)

    if (items.length === 0) throw new Error('Danh sách phát trống, hoặc đang để "Riêng tư" — máy chủ không xem được.')
    const title = data.metadata?.playlistMetadataRenderer?.title || data.header?.playlistHeaderRenderer?.title?.simpleText || ''
    return { title: String(title).trim(), items, hasMore: items.length >= 100 && html.includes('continuationCommand') }
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
    parsePlaylistId,
    fetchPlaylist,
    fetchYouTubeInfo,
    saveYouTubeThumb,
    removeVideoThumb,
    sendVideoThumb,
    VIDEO_ACCESS_HINT,
}
