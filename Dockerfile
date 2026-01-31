FROM node:20-alpine

WORKDIR /app

# Installera enbart produktionsberoenden
COPY package*.json ./
RUN npm install --only=production

# Kopiera källkod
COPY . .

# Exponera port
EXPOSE 3000

# Starta servern
CMD ["node", "server.js"]
