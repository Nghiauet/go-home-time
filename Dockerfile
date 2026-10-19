FROM node:22-alpine

WORKDIR /app

COPY server.js ./
COPY index.html styles.20260618-cols.css script.20260618-min.js sw.js favicon.20260611-glass.svg ./public/
COPY dashboard.html dashboard.20260610-glass.css dashboard.20260618-min.js styles.20260610-glass.css chart.umd.min.js ./public/
COPY fonts ./public/fonts/

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
