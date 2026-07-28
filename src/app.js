const express = require('express')
const cors = require('cors')
const path = require('path')
const routes = require('./routes')
const notFound = require('./middleware/notFound')
const errorHandler = require('./middleware/errorHandler')

const app = express()

const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
  })
)
app.use(express.json())

// Cho phép truy cập trực tiếp ảnh đã upload qua URL dạng /uploads/images/xxx.png
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

app.use('/api', routes)

app.use(notFound)
app.use(errorHandler)

module.exports = app
