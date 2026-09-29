# Cebian Telegram Gateway — Koyeb deploy image (Node 20 Alpine, siêu nhẹ)
FROM node:20-alpine

WORKDIR /app

# Cài dependency trước (layer cache — chỉ re-install khi lockfile đổi).
# `npm ci` (không phải `install`): cài đúng version đã pin trong package-lock.json
# → deploy reproducible, không tự nâng minor khi upstream ra bản mới. Đổi dependency
# thì chạy `npm install` ở local để cập nhật lockfile rồi commit cả hai file.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Source
COPY server.js ./

# Koyeb web service mặc định expose port 8000
ENV PORT=8000
EXPOSE 8000

# Container chạy user non-root (alpine node image có sẵn user "node")
USER node

CMD ["node", "server.js"]
