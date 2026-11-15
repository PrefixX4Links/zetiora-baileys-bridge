FROM node:20-alpine

WORKDIR /app

# Install dependencies needed for Baileys
RUN apk add --no-cache python3 make g++ git

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
