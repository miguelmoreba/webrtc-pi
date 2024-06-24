FROM node:18

# RUN apk add --no-cache gcompat libstdc++

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

RUN npx tsc

EXPOSE 3000

CMD ["node", "dist/main.js"]
