
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from deepgram import DeepgramClient, PrerecordedOptions
import os
import logging
import json
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("deepgram-webm-processor")

app = FastAPI()


def configure():
    load_dotenv()

# CORS: allow the browser to POST/OPTIONS (and GET if you ever need it)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
if not DEEPGRAM_API_KEY:
    raise RuntimeError("Missing DEEPGRAM_API_KEY")
dg = DeepgramClient(DEEPGRAM_API_KEY)

# WebM EBML header template (kept as in your original)
EBML_HEADER = bytes([
    0x1A, 0x45, 0xDF, 0xA3,  # EBML magic
    0x01, 0x00, 0x00, 0x00,   # Header size
    0x42, 0x86, 0x81, 0x01,   # Doc type = "webm"
    0x18, 0x53, 0x80, 0x67    # Segment info
])

def validate_and_repair_webm(chunk: bytes) -> bytes:
    """Ensure the WebM chunk has proper EBML headers"""
    # Check for existing EBML header
    if len(chunk) >= 4 and chunk[0] == 0x1A and chunk[1] == 0x45 and chunk[2] == 0xDF and chunk[3] == 0xA3:
        return chunk  # Already has headers
    
    # Prepend EBML header if missing
    logger.warning("WebM header missing - repairing")
    return EBML_HEADER + chunk

def hexdump(b: bytes, length: int = 128) -> str:
    return " ".join(f"{x:02X}" for x in b[:length])

@app.post("/transcribe_chunk")
async def transcribe_webm(
    file: UploadFile = File(...),
    config: str = Form("{}")
):
    try:
        chunk = await file.read()
        
        # Skip chunks that are too small to contain meaningful audio
        if len(chunk) < 2048:
            logger.info("Skipping small chunk")
            return {"status": "success", "text": ""}

        # Parse configuration
        try:
            cfg = json.loads(config)
        except json.JSONDecodeError:
            cfg = {}
            logger.warning("Using default config")

        # Detect file type
        ext = os.path.splitext(file.filename)[1].lower()
        if ext == ".wav":
            mimetype = "audio/wav"
            buffer = chunk
        else:
            mimetype = "audio/webm;codecs=opus"
            buffer = validate_and_repair_webm(chunk)

        options = PrerecordedOptions(
            model=cfg.get("model", "nova-2"),
            language=cfg.get("language", "en-US"),
            smart_format=True,
            punctuate=True
        )
        logger.info(f"Chunk size={len(chunk)} bytes")
        logger.info(f"Header hexdump (first 128B): {hexdump(chunk, 128)}")

        try:
            response = dg.listen.prerecorded.v("1").transcribe_file(
                {"buffer": buffer, "mimetype": mimetype},
                options
            )
            transcript = response.results.channels[0].alternatives[0].transcript
            logger.info(f"Transcription success: {len(transcript)} characters")
            return {
                "status": "success",
                "text": transcript,
                "model": options.model,
                "language": options.language,
                "duration": getattr(response.metadata, 'duration', None)
            }
        except Exception as e:
            logger.error(f"Transcription failed: {str(e)}")
            # Important: return structured error so the client shows ORANGE (LLM failed)
            return {
                "status": "error",
                "error": "Audio processing failed",
                "details": str(e)
            }

    except Exception as e:
        logger.error(f"Transcription failed: {str(e)}")
        # Python-level failure → client will show RED after retries
        return {
            "status": "error",
            "error": "Audio processing failed",
            "details": str(e)
        }

# NEW: Minimal health endpoint. Posts a tiny WAV to Deepgram to test the full pipeline.
@app.post("/health_ping")
async def health_ping(file: UploadFile = File(...)):
    """
    Accept a ~1KB audio file and forward to Deepgram to verify the full path.
    Returns booleans so the UI can set LED:
      - python_ok: server handled request body
      - llm_ok: Deepgram call returned without raising
    """
    python_ok = False
    llm_ok = False
    try:
        chunk = await file.read()
        python_ok = True  # reached the handler and read body

        # WAV preferred for this health check, fallback to treating as WebM if needed
        ext = os.path.splitext(file.filename or "")[1].lower()
        if ext == ".wav":
            mimetype = "audio/wav"
            buffer = chunk
        else:
            mimetype = "audio/webm;codecs=opus"
            buffer = chunk

        options = PrerecordedOptions(
            model="nova-2",
            language="en-US",
            smart_format=True,
            punctuate=True
        )

        try:
            _ = dg.listen.prerecorded.v("1").transcribe_file(
                {"buffer": buffer, "mimetype": mimetype},
                options
            )
            llm_ok = True
            return {"status": "ok", "python_ok": python_ok, "llm_ok": llm_ok}
        except Exception as e:
            logger.error(f"Health LLM call failed: {str(e)}")
            return {
                "status": "error",
                "python_ok": python_ok,
                "llm_ok": llm_ok,
                "details": str(e)
            }

    except Exception as e:
        logger.error(f"/health_ping failed: {str(e)}")
        return {
            "status": "error",
            "python_ok": python_ok,  # False
            "llm_ok": llm_ok,        # False
            "details": str(e)
        }

if __name__ == "__main__":
    import uvicorn
    configure()
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")

