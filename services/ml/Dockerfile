FROM python:3.12-slim

# ffmpeg: Browser-Audio → WAV; tesseract + poppler: OCR für eingescannte PDFs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Modelle landen im Volume, damit sie nicht bei jedem Neustart neu geladen werden.
ENV HF_HOME=/models
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
