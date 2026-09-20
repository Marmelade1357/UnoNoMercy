FROM node:20-alpine
WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js .
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1

CMD ["node", "server.js"]
