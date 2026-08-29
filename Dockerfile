FROM node:20-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

COPY server ./server
COPY public ./public
COPY migration ./migration

ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 8080
CMD ["node", "server/server.js"]
