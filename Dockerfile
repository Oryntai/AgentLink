FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV AGENT_LINK_HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "src/relay-server.js"]
