FROM node:26-slim AS deps

WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci

FROM deps AS build

WORKDIR /app
COPY ./migrations ./migrations
COPY ./src ./src
RUN npm run build

FROM build AS tasks

WORKDIR /app
COPY ./migrate-mongo-config.js ./

FROM node:26-slim AS prod-deps

WORKDIR /app
COPY package*.json ./
# `prepare` runs `husky`, a devDependency with no binary to find once dev deps are omitted, and a
# runtime image has no git hooks to install. Dropping that one script keeps every other package's
# install scripts running, which a blanket `--ignore-scripts` would suppress.
RUN npm pkg delete scripts.prepare && npm ci --omit=dev

FROM node:26-slim AS runtime
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY ./migrate-mongo-config.js ./
COPY ./migrations ./migrations
COPY ./package.json ./

USER node

EXPOSE 3000
# `--import ./dist/instrumentation.js` mirrors the `start:prod` script and registers the
# Prometheus metric reader. Without it the process starts fine and exports no metrics, so its
# Prometheus scrape target never comes up.
ENTRYPOINT ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
