FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY playwright.config.js journey.pw.js ./
ENV HOME=/tmp PW_OUTPUT_DIR=/results/playwright
CMD ["npm", "test"]
