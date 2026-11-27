use rusqlite::Connection;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS lib_tracks(
  video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT,
  duration REAL,
  cover TEXT,
  added_at INTEGER NOT NULL,
  artist_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lib_tags(
  video_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY(video_id, tag)
);
CREATE INDEX IF NOT EXISTS lib_tags_tag ON lib_tags(tag);
CREATE TABLE IF NOT EXISTS lib_collections(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lib_collection_items(
  collection_id INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  PRIMARY KEY(collection_id, video_id)
);
";

pub fn migrate(c: &Connection) {
    let _ = c.execute_batch(SCHEMA);
}
