# Cebian Telegram Gateway — Koyeb deploy image (Node 20 Alpine, siêu nhẹ)
FROM node:20-alpine

WORKDIR /app

# Cài dependency trước (layer cache — chỉ re-install khi package.json đổi)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Source
COPY server.js ./

# Koyeb web service mặc định expose port 8000
ENV PORT=8000
EXPOSE 8000

# Container chạy user non-root (alpine node image có sẵn user "node")
USER node

CMD ["node", "server.js"]
