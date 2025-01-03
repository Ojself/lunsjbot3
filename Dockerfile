# Use the official Puppeteer image which includes Chromium
FROM ghcr.io/puppeteer/puppeteer:19.7.2

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json for dependency installation
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application files
COPY . .

# Expose the necessary port (if your app requires one)
EXPOSE 3000

# Command to run your app
CMD ["node", "app.js"]
