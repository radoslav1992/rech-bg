FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.py /app/server.py
RUN useradd --create-home renderer
USER renderer
EXPOSE 8080
CMD ["python", "-u", "/app/server.py"]
