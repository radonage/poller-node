FROM node:20-alpine

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY poller.js ./

EXPOSE 8080

CMD ["npm", "start"]
