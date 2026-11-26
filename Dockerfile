FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY server.js ./
COPY public ./public

ENV PORT=3000
ENV NODE_ENV=production
ENV DB_PATH=/app/data/udhaar.db

RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "server.js"]
