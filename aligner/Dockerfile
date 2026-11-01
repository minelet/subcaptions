FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
# verification.json (written by tools/verify_real_audio.py) may be copied in too
COPY verification.jso[n] ./
ENV PORT=8000
CMD ["sh","-c","uvicorn server:app --host 0.0.0.0 --port ${PORT} --workers 1"]
