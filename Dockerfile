FROM node:18-slim

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy application source
COPY . .

EXPOSE 8000

CMD ["npm", "start"]