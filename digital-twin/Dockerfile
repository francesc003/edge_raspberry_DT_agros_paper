FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Copia tutto il codice del DT
COPY . ./

# Cartella per i log (montata come volume nel compose)
RUN mkdir -p /app/logs

CMD ["node", "index_mongo.js"]
