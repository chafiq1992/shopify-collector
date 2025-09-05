# --------- Frontend build stage ---------
FROM node:20-bullseye-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install
COPY frontend/ ./
# Accept Vite envs as build args and expose as env so Vite embeds them
ARG VITE_PRINT_RELAY_URL
ARG VITE_PRINT_RELAY_API_KEY
ARG VITE_PRINT_RELAY_PC_ID
ENV VITE_PRINT_RELAY_URL=${VITE_PRINT_RELAY_URL}
ENV VITE_PRINT_RELAY_API_KEY=${VITE_PRINT_RELAY_API_KEY}
ENV VITE_PRINT_RELAY_PC_ID=${VITE_PRINT_RELAY_PC_ID}
RUN node node_modules/vite/bin/vite.js build

# --------- Backend runtime ---------
FROM python:3.11-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080
WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/ ./backend/

# Copy built frontend
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Expose port and run
CMD exec uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT

