FROM --platform=linux/amd64 node:20-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
# --platform=linux/amd64 above forces this build (and the native
# better-sqlite3 binary it installs) to target amd64 regardless of what
# CPU architecture the build machine itself runs on. Without it, a builder
# running on different hardware than the deploy target (which is exactly
# what Railway's "Metal builder" can do) ships a native module compiled
# for the wrong architecture -> "Exec format error" at container start.
RUN cd server && npm install --omit=dev

COPY server ./server
COPY public ./public
COPY migration ./migration

ENV DATA_DIR=/app/data
# Note: no Docker VOLUME instruction here on purpose -- Railway's builder
# rejects it and wants persistent storage configured as a Railway Volume
# instead (Settings -> Volumes -> mount path /app/data). Same idea on
# Render: add a Disk mounted at /app/data.

EXPOSE 8080
CMD ["node", "server/server.js"]
