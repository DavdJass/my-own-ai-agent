"""
System configuration — all tunables in one place.
Designed for Raspberry Pi 5 (ARM64, 4-8 GB RAM).
"""
import os
from pathlib import Path

# ─── Base Directories ─────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "image_indexer" / "data"
MODELS_DIR = BASE_DIR / "image_indexer" / "models_cache"
THUMBNAILS_DIR = DATA_DIR / "thumbnails"
UPLOAD_DIRS = [Path.cwd() / "watched_directories"]  # can be extended at runtime

# Create dirs on import
for _d in (DATA_DIR, MODELS_DIR, THUMBNAILS_DIR, UPLOAD_DIRS[0]):
    _d.mkdir(parents=True, exist_ok=True)

# ─── Database ─────────────────────────────────────────────────────────────────
DATABASE_PATH = str(DATA_DIR / "index.db")
FAISS_INDEX_PATH = str(DATA_DIR / "faiss_index.bin")

# ─── Image Optimisation ──────────────────────────────────────────────────────
MAX_IMAGE_SIZE = (640, 640)       # resize before inference
THUMBNAIL_SIZE = (256, 256)
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}
QUALITY = 85                      # JPEG quality for thumbnails

# ─── Models ───────────────────────────────────────────────────────────────────
# Object detection: "mobilenet_ssd" (default, lighter) or "yolov8n" (heavier)
DETECTION_MODEL = "mobilenet_ssd"
# URL for downloading the TFLite model if not present
MOBILENET_SSD_URL = (
    "https://storage.googleapis.com/download.tensorflow.org/"
    "models/tflite/model_zoo/vision_models/ssd_mobilenet_v2_coco_quant.tflite"
)
MOBILENET_LABELS_URL = (
    "https://storage.googleapis.com/download.tensorflow.org/"
    "models/tflite/model_zoo/vision_models/coco_labels.txt"
)
YOLOV8N_URL = "https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n_float32.tflite"

# Embeddings – using all-MiniLM-L6-v2 (≈80 MB quantized)
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIM = 384
# Lower batch size for low-memory devices
EMBEDDING_BATCH_SIZE = 1

# ─── Worker ───────────────────────────────────────────────────────────────────
MAX_WORKERS = 1                   # single-worker to stay gentle on RAM
QUEUE_POLL_INTERVAL = 1.0         # seconds between queue polls
PROCESS_BATCH_SIZE = 1            # one image at a time

# ─── OCR ──────────────────────────────────────────────────────────────────────
TESSERACT_CMD = "tesseract"       # full path if needed
OCR_LANGUAGE = "eng+spa+fra"      # adjust to your locale; eng is smallest

# ─── FAISS ────────────────────────────────────────────────────────────────────
FAISS_INDEX_TYPE = "Flat"         # "Flat" (exact) or "IVF" (faster, approximate)
FAISS_NPROBE = 10                 # IVF nprobe param (ignored for Flat)

# ─── Server ───────────────────────────────────────────────────────────────────
HOST = "0.0.0.0"
PORT = 8000
RELOAD = False                    # set True only during development

# ─── Search ───────────────────────────────────────────────────────────────────
DEFAULT_TOP_K = 20                # max results returned per search
SEARCH_CONFIDENCE_THRESHOLD = 0.15  # minimum similarity score

# ─── Logging ──────────────────────────────────────────────────────────────────
LOG_LEVEL = "INFO"
LOG_FILE = str(DATA_DIR / "indexer.log")
