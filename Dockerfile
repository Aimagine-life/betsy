FROM node:22-slim

# Install Playwright dependencies
RUN apt-get update && apt-get install -y \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

# Install Playwright Chromium
RUN npx playwright install chromium

COPY dist/ ./dist/

EXPOSE 3777

CMD ["node", "dist/index.js"]
