FROM node:22-alpine

WORKDIR /app

# Runtime needs only `node`. Drop the package managers the base image ships
# (npm, npx, corepack, yarn): nothing here calls them, and they only add
# attack surface and vulnerability-scanner findings.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY server.js ./
COPY index.html styles.20261101-undo.css script.20261101-undo.js sw.js favicon.20260611-glass.svg ./public/
COPY dashboard.html dashboard.20260610-glass.css dashboard.20260618-min.js styles.20260610-glass.css chart.umd.min.js ./public/
COPY fonts ./public/fonts/

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
