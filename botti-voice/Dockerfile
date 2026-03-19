FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY web/ ./web/

ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "web.server:app", "--host", "0.0.0.0", "--port", "8080"]
