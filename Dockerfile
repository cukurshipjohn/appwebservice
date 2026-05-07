FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy all source code
COPY . .

# Expose port explicitly for Coolify's Nginx Proxy
EXPOSE 3001

# Command to run the application
CMD ["node", "server.js"]
