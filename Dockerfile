# Stage 1: Compile modular TypeScript frontend (src/*.ts -> app.js)
FROM node:22-slim AS frontend-builder
WORKDIR /build
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN npm run build

# Stage 2: Python FastAPI runtime
FROM python:3.11-slim

WORKDIR /app

# Install psutil build tools if compilation is needed, but slim generally has prebuilt wheels
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    python3-dev \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
COPY --from=frontend-builder /build/app.js /app/app.js

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
