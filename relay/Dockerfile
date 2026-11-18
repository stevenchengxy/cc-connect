FROM node:24-alpine
WORKDIR /app
RUN npm install --no-save --ignore-scripts --omit=dev --no-audit --no-fund ws@8.23.0
COPY server.cjs .
USER node
CMD ["node","server.cjs"]
