FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FRAMENOTE_MEDIA_STATE_DIR=/data \
    FRAMENOTE_MEDIA_ALLOW_TOKENLESS_LOOPBACK=0 \
    MODELSCOPE_CACHE=/data/model-cache

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --requirement /app/requirements.txt

COPY . /app/media_service

RUN useradd --create-home --uid 10001 framenote \
    && mkdir --parents /data \
    && chown --recursive framenote:framenote /data /app

USER framenote

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8788/health', timeout=3).read()"

CMD ["uvicorn", "media_service.main:app", "--host", "0.0.0.0", "--port", "8788", "--no-access-log"]
