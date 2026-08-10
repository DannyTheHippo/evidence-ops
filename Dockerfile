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

FROM node:26-slim AS runtime
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY ./migrate-mongo-config.js ./
COPY ./migrations ./migrations
COPY ./package.json ./

USER node

EXPOSE 3000
ENTRYPOINT ["node", "dist/main.js"]
