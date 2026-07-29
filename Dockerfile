FROM node:20-alpine
WORKDIR /app

# ffmpeg dùng để nén video tự động sau khi admin upload
RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 4000
CMD ["node", "src/server.js"]