FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p data && chown -R node:node data
USER node

EXPOSE 3000

CMD ["node", "api/webhooks/index.js"]
