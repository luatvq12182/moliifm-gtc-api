FROM node:20-alpine
WORKDIR /app

# ffmpeg: nén video tự động sau khi admin upload.
# libreoffice + poppler-utils: "Học liệu khoá học" — chuyển slide PowerPoint/PDF
#   thành ảnh từng trang (xem src/lib/materialConvert.js).
# font-noto-cjk: chữ Hán trong slide. ttf-liberation: thay cho Arial/Times
#   (cùng kích thước chữ nên bố cục slide ít lệch). ttf-dejavu: chữ Việt có dấu.
RUN apk add --no-cache ffmpeg libreoffice poppler-utils font-noto-cjk ttf-liberation ttf-dejavu

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 4000
CMD ["node", "src/server.js"]