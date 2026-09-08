FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY index.js .
EXPOSE 3001
CMD ["node", "index.js"]
