# Snag website: build and verify the static site, then serve it from an unprivileged nginx.
#   docker build --build-arg SITE_URL=https://snag.example.org -t snag-website website/
FROM node:22-alpine AS build
WORKDIR /site
COPY package.json build.mjs check.mjs site.config.mjs ./
COPY src ./src
COPY tests ./tests
COPY deploy ./deploy
ARG SITE_URL=http://localhost:4180
ENV SITE_URL=${SITE_URL}
RUN node build.mjs && node check.mjs && node --test tests/*.test.mjs

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /site/build/nginx/ /etc/nginx/snag/
COPY --from=build /site/dist/ /usr/share/nginx/html/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
