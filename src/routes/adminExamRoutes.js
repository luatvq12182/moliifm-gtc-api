const express = require('express')
const c = require('../controllers/examAdminController')
const t = require('../controllers/examTestAdminController')
const r = require('../controllers/examResultAdminController')
const { protectAdmin } = require('../middleware/auth')

// Luyện thi HSK 3.0 — phía quản trị.
const router = express.Router()
router.use(protectAdmin)

router.get('/levels', c.listLevels)
router.post('/levels', c.createLevel)
router.put('/levels/:id', c.updateLevel)
router.delete('/levels/:id', c.deleteLevel)

router.get('/videos', c.listVideos)
router.post('/videos', c.createVideo)
router.post('/videos/playlist', c.importPlaylist)
// Đường dẫn cố định khai báo TRƯỚC đường dẫn có tham số.
router.put('/videos/reorder', c.reorderVideos)
router.put('/videos/:id', c.updateVideo)
router.delete('/videos/:id', c.deleteVideo)
router.get('/videos/:id/thumb', c.getVideoThumb)

router.get('/templates', t.listTemplates)
router.get('/tests', t.listTests)
router.post('/tests', t.createTest)
router.put('/tests/reorder', t.reorderTests)
router.get('/tests/:id', t.getTest)
router.put('/tests/:id', t.updateTest)
router.delete('/tests/:id', t.deleteTest)
router.post('/tests/:id/pdf', t.uploadPdf)
router.post('/tests/:id/pdf/convert', t.reconvertPdf)
router.put('/tests/:id/pages', t.setHiddenPages)
router.get('/tests/:id/pages/:n', t.getPage)
router.post('/tests/:id/audio', t.uploadAudio)
router.delete('/tests/:id/audio', t.deleteAudio)
router.get('/tests/:id/audio', t.getAudio)
router.post('/tests/:id/regrade', r.regradeTest)

router.get('/attempts', r.listAttempts)
router.get('/attempts/:id', r.getAttempt)
router.post('/attempts/:id/regrade', r.regradeAttempt)
router.delete('/attempts/:id', r.deleteAttempt)

router.get('/access', c.listAccess)
router.patch('/access', c.updateAccess)

module.exports = router
