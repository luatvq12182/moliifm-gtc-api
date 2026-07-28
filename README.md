# GTC API — Admin Auth & Quản lý tài khoản học viên

Node.js + Express + MongoDB + Mongoose (JavaScript thuần, không TypeScript).

Phạm vi hiện tại (theo đúng yêu cầu, chưa làm các phần khác):
- Đăng nhập admin (JWT)
- CRUD quản lý tài khoản học viên: thêm, sửa, khóa/mở khóa, xóa, tìm kiếm + phân trang

Chưa làm (để sau): đăng nhập học viên, quản lý tiến độ học tập, quản lý nội dung
Giáo trình/Khóa học/Bài học.

## 1. Cài đặt

```bash
npm install
```

Cần có MongoDB đang chạy (local hoặc MongoDB Atlas). Nếu VPS của bạn đã có sẵn container
`lms_mongo` (thấy trong các lần trao đổi trước), có thể trỏ thẳng vào đó — chỉ cần đổi
`MONGO_URI` cho đúng (xem mục 2).

## 2. Cấu hình môi trường

```bash
cp .env.example .env
```

Mở `.env` và điền:

```
PORT=4000
MONGO_URI=mongodb://localhost:27017/gtc_admin
JWT_SECRET=<chuỗi bí mật dài, ngẫu nhiên>
JWT_EXPIRES_IN=7d

ADMIN_NAME=Super Admin
ADMIN_EMAIL=admin@molii.vn
ADMIN_PASSWORD=<mật khẩu admin đầu tiên>

CLIENT_ORIGIN=http://localhost:5173
```

**Lưu ý bảo mật:** `JWT_SECRET` nên là chuỗi ngẫu nhiên dài (32+ ký tự), không dùng giá trị
mẫu trong `.env.example`. Có thể tạo nhanh bằng:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`CLIENT_ORIGIN` là domain của frontend được phép gọi API (CORS) — nếu có nhiều domain
(vd. vừa localhost lúc dev vừa domain thật lúc production), cách nhau bằng dấu phẩy:
```
CLIENT_ORIGIN=http://localhost:5173,https://gtc.molii.vn
```

## 3. Tạo tài khoản admin đầu tiên

Vì hệ thống chưa có UI đăng ký admin (chỉ admin có sẵn mới tạo được admin khác — nhưng
bước "tạo admin khác" chưa làm ở phạm vi này), cần seed 1 tài khoản admin đầu tiên bằng
script:

```bash
npm run seed:admin
```

Script đọc `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` từ `.env`, tự bỏ qua nếu email
đã tồn tại (chạy lại nhiều lần không tạo trùng).

## 4. Chạy server

Development (tự restart khi sửa code):
```bash
npm run dev
```

Production:
```bash
npm start
```

Kiểm tra server sống chưa:
```bash
curl http://localhost:4000/api/health
```

## 5. API Reference

Base URL: `http://localhost:4000/api`

### Auth

**POST `/auth/login`** — đăng nhập, không cần token
```json
// Request body
{ "email": "admin@molii.vn", "password": "..." }

// Response 200
{
  "token": "eyJhbGciOi...",
  "admin": { "id": "...", "name": "Super Admin", "email": "admin@molii.vn", "role": "super_admin" }
}
```

**GET `/auth/me`** — lấy thông tin admin đang đăng nhập (cần token)

Với mọi route cần đăng nhập, gửi kèm header:
```
Authorization: Bearer <token>
```

### Học viên (tất cả đều cần token admin)

**GET `/students`** — danh sách, hỗ trợ query:
- `search` — tìm theo tên hoặc email
- `status` — lọc `active` hoặc `locked`
- `page`, `limit` — phân trang (mặc định page=1, limit=20, tối đa limit=100)

```
GET /students?search=nhi&status=active&page=1&limit=20
```
```json
{
  "data": [ { "_id": "...", "name": "...", "email": "...", "status": "active", ... } ],
  "pagination": { "total": 42, "page": 1, "limit": 20, "totalPages": 3 }
}
```

**POST `/students`** — tạo học viên mới
```json
// Request body
{ "name": "Nguyễn Thu Hà", "email": "thuha@gmail.com", "phone": "0901234567", "course": "HSK1" }
```
```json
// Response 201 — tempPassword chỉ trả về DUY NHẤT 1 lần lúc tạo, không lưu lại
// dạng đọc được, admin cần copy gửi cho học viên ngay lúc này
{
  "student": { "_id": "...", "name": "...", "email": "...", "status": "active", ... },
  "tempPassword": "aB3dEfGh12"
}
```

**GET `/students/:id`** — chi tiết 1 học viên

**PUT `/students/:id`** — cập nhật thông tin cơ bản
```json
{ "name": "...", "phone": "...", "course": "HSK2" }
```

**PATCH `/students/:id/status`** — khóa / mở khóa (tự đảo trạng thái hiện tại, không cần gửi body)

**DELETE `/students/:id`** — xóa học viên

## 6. Cấu trúc thư mục

```
src/
  config/db.js              # kết nối MongoDB
  models/
    Admin.js                 # schema admin, hash password tự động
    Student.js                # schema học viên, hash password tự động
  middleware/
    auth.js                   # xác thực JWT, gắn req.admin
    notFound.js                # bắt route không tồn tại (404)
    errorHandler.js            # xử lý lỗi tập trung, format JSON thống nhất
  controllers/
    authController.js          # login, getMe
    studentController.js       # CRUD + khóa/mở khóa + tìm kiếm/phân trang
  routes/
    authRoutes.js
    studentRoutes.js
    index.js                    # gộp route, gắn /api/health
  utils/
    asyncHandler.js             # bọc async controller, tự next(err)
    generatePassword.js          # sinh mật khẩu tạm khi tạo học viên mới
  seed/
    seedAdmin.js                  # script tạo admin đầu tiên
  app.js                          # cấu hình Express app (cors, json, routes)
  server.js                        # điểm khởi động, connect DB rồi listen
```

## 7. Việc cần làm tiếp theo (ngoài phạm vi hiện tại)

- Đăng nhập học viên (route `/api/students/login` riêng, hoặc gộp chung 1 endpoint
  `/api/auth/login` phân biệt theo role — cần quyết định trước khi làm)
- Đổi mật khẩu / quên mật khẩu cho cả admin và học viên
- Module Giáo trình → Khóa học → Bài học (đang chờ chốt schema theo phần thảo luận
  trước — đặc biệt là câu hỏi khóa học có thuộc chết vào 1 giáo trình hay dùng chung)
- Quản lý tiến độ học tập của học viên theo từng bài
- Refresh token / thu hồi token khi cần đăng xuất từ xa (hiện tại JWT chỉ hết hạn tự
  nhiên theo `JWT_EXPIRES_IN`, không có cơ chế thu hồi sớm)
- Giới hạn tốc độ gọi API (rate limiting) cho route `/auth/login` để chống brute-force
