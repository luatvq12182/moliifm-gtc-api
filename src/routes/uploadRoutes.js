const express = require('express')
const upload = require('../middleware/upload')
const uploadVideoMiddleware = require('../middleware/uploadVideo')
const { uploadImage, uploadVideo } = require('../controllers/uploadController')
const { protectAdmin } = require('../middleware/auth')

const router = express.Router()

router.post('/image', protectAdmin, upload.single('image'), uploadImage)
router.post('/video', protectAdmin, uploadVideoMiddleware.single('video'), uploadVideo)

module.exports = router