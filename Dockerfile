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

# `OtlpFileSpanExporter`'s constructor calls `mkdirSync(process.cwd()/artifacts/traces)`
# unconditionally, and everything COPYed above is root-owned — so under `USER node` the
# instrumentation below would throw before the app ever started. Created and chowned here rather
# than made conditional, so the container and the host loop run the identical code path.
RUN mkdir -p /app/artifacts/traces && chown -R node:node /app/artifacts

USER node

EXPOSE 3000
# `--import ./dist/instrumentation.js` mirrors the `start:prod` script. Without it the process
# starts fine and emits nothing: no http/express/mongoose spans, and the compose-wired
# `OTEL_EXPORTER_OTLP_ENDPOINT` is inert. That is a silent failure — the container is healthy,
# Jaeger is simply empty — which is why it survived until a trace was actually looked for.
ENTRYPOINT ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
