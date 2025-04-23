FROM node:18-slim

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm config set strict-ssl false && npm install --omit=dev

# Copy application source
COPY . .

EXPOSE 8000

CMD ["npm", "start"]