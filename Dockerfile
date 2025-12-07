FROM python:3.11-slim

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first for caching
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server code
COPY server/ .
COPY .env* ./

# Expose port
EXPOSE 8000

# Run server
CMD ["python", "server.py"]
