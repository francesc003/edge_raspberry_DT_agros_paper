# Immagine Node ufficiale, variante slim (leggera, multi-arch: vale anche per ARM64/Raspberry)
FROM node:20-slim

WORKDIR /app

# Installa solo le dipendenze (sfrutta la cache di Docker)
COPY package.json ./
RUN npm install --omit=dev

# Copia il codice
COPY simulator.js ./

CMD ["node", "simulator.js"]
