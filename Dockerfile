FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY poller.js ./

CMD ["npm", "start"]
