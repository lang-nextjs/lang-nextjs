FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PYTHONUNBUFFERED=1

# Drop root before running the app — see apps/fastapi-backend/Dockerfile for
# the rationale. The network-facing process should not own the container.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
CMD ["uvicorn", "deepagents_backend.asgi:application", "--host", "0.0.0.0", "--port", "8000"]
