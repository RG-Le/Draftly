FROM node:20-alpine
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source (will be overridden by volume mounts in dev)
COPY . .

EXPOSE 3001

# Run the Vite dev server, bound to all interfaces so Docker can forward
CMD ["npm", "run", "dev"]
