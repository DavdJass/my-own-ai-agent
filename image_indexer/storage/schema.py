"""
SQLite database schema for the image indexer.
"""
from datetime import datetime

# ─── Schema Definition ────────────────────────────────────────────────────────

CREATE_TABLES_SQL = """
-- Main image records
CREATE TABLE IF NOT EXISTS images (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path       TEXT    NOT NULL UNIQUE,
    file_name       TEXT    NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    width           INTEGER,
    height          INTEGER,
    format          TEXT,
    thumbnail_path  TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    status          TEXT    NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error_message   TEXT
);

-- Detected objects
CREATE TABLE IF NOT EXISTS objects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id    INTEGER NOT NULL,
    label       TEXT    NOT NULL,
    confidence  REAL    NOT NULL,
    bbox_x      INTEGER,
    bbox_y      INTEGER,
    bbox_w      INTEGER,
    bbox_h      INTEGER,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

-- Auto-generated categories (e.g. "people", "nature", "food")
CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id    INTEGER NOT NULL,
    category    TEXT    NOT NULL,
    confidence  REAL,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

-- Extracted text from OCR
CREATE TABLE IF NOT EXISTS ocr_texts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id    INTEGER NOT NULL UNIQUE,
    text        TEXT    NOT NULL,
    language    TEXT,
    confidence  REAL,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

-- Tags generated from detectors + embeddings
CREATE TABLE IF NOT EXISTS tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id    INTEGER NOT NULL,
    tag         TEXT    NOT NULL,
    source      TEXT    NOT NULL DEFAULT 'auto'
        CHECK (source IN ('auto', 'manual', 'ocr', 'detection')),
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

-- Full-text search virtual table (for keyword search on OCR + tags)
CREATE VIRTUAL TABLE IF NOT EXISTS image_fts USING fts5(
    file_name,
    tags,
    ocr_text,
    content='',
    tokenize='porter unicode61'
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_images_status     ON images(status);
CREATE INDEX IF NOT EXISTS idx_images_created_at ON images(created_at);
CREATE INDEX IF NOT EXISTS idx_objects_label     ON objects(label);
CREATE INDEX IF NOT EXISTS idx_tags_tag          ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_categories_cat    ON categories(category);
"""


def get_schema_version() -> int:
    """Return schema version for future migrations."""
    return 1
