FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv/dashboard

RUN useradd --create-home --uid 10001 dashboard
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
# data/ holds the Spotify refresh token; it is a mounted volume in production.
RUN mkdir -p /srv/dashboard/data && chown -R dashboard:dashboard /srv/dashboard/data
USER dashboard

# The reverse proxy (Caddy) is the only client, so forwarded headers can be trusted.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765", "--proxy-headers", "--forwarded-allow-ips=*"]
