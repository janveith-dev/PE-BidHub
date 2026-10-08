"""ML-Dienst für bid-hub: Spracherkennung (Whisper), Embeddings und Texterkennung (OCR).

Alles läuft lokal; es verlassen weder Audio noch Dokumenttexte das Haus. Die Modelle werden beim ersten
Aufruf geladen und im Speicher gehalten (Download-Cache: HF_HOME).
"""
from __future__ import annotations

import io
import os
import subprocess
import threading
from typing import Literal

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
# 384 Dimensionen, passend zur Datenbankspalte vector(384). Auf einem kleinen deutsch-englischen Suchtest
# schnitt es besser ab als multilingual-e5-small und ist in fastembed ohne Sonderregistrierung verfügbar.
# Ein anderes Modell mit anderer Dimension verlangt eine Schemaänderung und `POST /api/admin/reindex`.
EMBED_MODEL = os.environ.get("EMBED_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
# Fachbegriffe als Kontext verbessern die Erkennung von Produkt- und Firmennamen deutlich.
WHISPER_PROMPT = os.environ.get(
    "WHISPER_PROMPT",
    "public edge, Dell PowerEdge, NetApp, Hitachi Vantara, Lenovo ThinkSystem, Fsas Fujitsu, Huawei, "
    "ISO 27001, ITIL, BSI IT-Grundschutz, Rechenzentrum, Servicekonzept, Ausschreibung, SLA.",
)
MAX_AUDIO_BYTES = 25 * 1024 * 1024

app = FastAPI(title="bid-hub ML", version="0.1.0")

_lock = threading.Lock()
_whisper = None
_embedder = None


def whisper_model():
    global _whisper
    with _lock:
        if _whisper is None:
            from faster_whisper import WhisperModel

            _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type=WHISPER_COMPUTE)
        return _whisper


def embedder():
    global _embedder
    with _lock:
        if _embedder is None:
            from fastembed import TextEmbedding

            _embedder = TextEmbedding(model_name=EMBED_MODEL)
        return _embedder


@app.get("/health")
def health():
    return {
        "status": "ok",
        "whisper": {"model": WHISPER_MODEL, "loaded": _whisper is not None},
        "embedding": {"model": EMBED_MODEL, "loaded": _embedder is not None},
        "ocr": _tesseract_available(),
    }


# --- Spracherkennung -------------------------------------------------------------------------------------


def _to_pcm(data: bytes) -> np.ndarray:
    """Browser-Aufnahmen (webm/opus, mp4, wav …) per ffmpeg in 16-kHz-Mono-Samples wandeln.

    Whisper bekommt das fertige Array statt einer Datei: Die eigene Dekodierung von faster-whisper hängt
    an PyAV, dessen Programmierschnittstelle sich zwischen Versionen ändert.
    """
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"],
        input=data,
        capture_output=True,
        timeout=60,
    )
    if proc.returncode != 0 or len(proc.stdout) < 2:
        raise HTTPException(422, f"Audio nicht lesbar: {proc.stderr.decode(errors='ignore')[:200]}")
    pcm = proc.stdout[: len(proc.stdout) // 2 * 2]
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    # Ein Vorlauf aus Stille: Setzt die Sprache sofort ein, schneidet der Stillefilter sonst den ersten Laut ab
    # („Gibt es …" → „Ibt es …").
    pad = np.zeros(int(0.3 * 16000), dtype=np.float32)
    return np.concatenate([pad, samples, pad])


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str | None = Form(None)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Leere Aufnahme")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Aufnahme zu groß")
    if language not in (None, "", "de", "en"):
        raise HTTPException(400, "language muss de oder en sein")

    audio = _to_pcm(data)
    model = whisper_model()
    segments, info = model.transcribe(
        audio,
        language=language or None,
        beam_size=1,
        vad_filter=True,  # schneidet Stille ab und verhindert erfundene Sätze bei leeren Aufnahmen
        initial_prompt=WHISPER_PROMPT,
        condition_on_previous_text=False,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": info.language, "duration": round(info.duration, 2)}


# --- Embeddings ---------------------------------------------------------------------------------------------


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)
    kind: Literal["passage", "query"] = "passage"


@app.post("/embed")
def embed(req: EmbedRequest):
    # `kind` bleibt Teil der Schnittstelle (Modelle der E5-Familie brauchen Präfixe), dieses Modell nicht.
    vectors = list(embedder().embed([t[:4000] for t in req.texts]))
    out = []
    for v in vectors:
        arr = np.asarray(v, dtype=np.float32)
        norm = float(np.linalg.norm(arr))
        out.append((arr / norm if norm else arr).tolist())
    return {"embeddings": out, "model": EMBED_MODEL, "dim": len(out[0])}


# --- Texterkennung ----------------------------------------------------------------------------------------------


def _tesseract_available() -> bool:
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


@app.post("/ocr")
async def ocr(file: UploadFile = File(...)):
    import pytesseract
    from PIL import Image

    if not _tesseract_available():
        raise HTTPException(503, "Tesseract ist nicht installiert")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Leere Datei")

    name = (file.filename or "").lower()
    is_pdf = data[:5] == b"%PDF-" or name.endswith(".pdf")
    try:
        if is_pdf:
            from pdf2image import convert_from_bytes

            images = convert_from_bytes(data, dpi=250)
        else:
            images = [Image.open(io.BytesIO(data))]
    except Exception as exc:  # beschädigte Datei, unbekanntes Format
        raise HTTPException(422, f"Datei nicht lesbar: {exc}") from exc

    pages = [pytesseract.image_to_string(img, lang="deu+eng").strip() for img in images]
    return {"pages": pages}
