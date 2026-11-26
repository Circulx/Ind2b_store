# Production image: docker build -t ind2b . && docker run -p 3000:3000 --env-file .env.production ind2b
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 TRUST_PROXY=true
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/package.json /app/next.config.mjs ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
USER app
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
