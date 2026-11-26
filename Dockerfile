FROM node:22-alpine

WORKDIR /app

# Install dependencies cleanly
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source files
COPY . .

ENV PORT=10000
ENV NODE_ENV=production

EXPOSE 10000

CMD ["node", "server.js"]
