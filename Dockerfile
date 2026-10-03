# Long-running worker (Railway / Render / Fly.io / any Docker host)
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY sql ./sql
USER node
EXPOSE 3000
CMD ["node", "dist/src/worker.js"]
