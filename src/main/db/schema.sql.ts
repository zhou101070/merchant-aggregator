/** Schema version 1 — historical soft-ref schema (includes offers). */
export const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  store_name TEXT,
  host TEXT,
  shop_url TEXT,
  entry_url TEXT,
  source_id TEXT,
  source_name TEXT,
  collector_kind TEXT,
  health_status TEXT,
  offer_count INTEGER NOT NULL DEFAULT 0,
  in_stock_count INTEGER NOT NULL DEFAULT 0,
  out_of_stock_count INTEGER NOT NULL DEFAULT 0,
  product_count INTEGER NOT NULL DEFAULT 0,
  platform_count INTEGER NOT NULL DEFAULT 0,
  platforms_json TEXT NOT NULL DEFAULT '[]',
  product_types_json TEXT NOT NULL DEFAULT '[]',
  representative_product TEXT,
  representative_offer_title TEXT,
  representative_price REAL,
  representative_currency TEXT,
  lowest_hit_count INTEGER DEFAULT 0,
  warranty_lowest_hit_count INTEGER DEFAULT 0,
  risk_feedback_count INTEGER DEFAULT 0,
  has_platform_aftersales INTEGER NOT NULL DEFAULT 0,
  shop_created_at TEXT,
  included_at TEXT,
  last_success_at TEXT,
  latest_seen_at TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  observation_started_at TEXT,
  generated_at TEXT,
  fetched_at TEXT NOT NULL,
  raw_json TEXT,
  ldxp_token TEXT,
  name_norm TEXT
);

CREATE INDEX IF NOT EXISTS idx_merchants_source_id ON merchants(source_id);
CREATE INDEX IF NOT EXISTS idx_merchants_host ON merchants(host);
CREATE INDEX IF NOT EXISTS idx_merchants_name_norm ON merchants(name_norm);
CREATE INDEX IF NOT EXISTS idx_merchants_health ON merchants(health_status);
CREATE INDEX IF NOT EXISTS idx_merchants_ldxp_token ON merchants(ldxp_token);

CREATE TABLE IF NOT EXISTS catalog_products (
  id TEXT PRIMARY KEY,
  slug TEXT,
  display_name TEXT NOT NULL,
  platform TEXT,
  product_type TEXT,
  aliases_json TEXT,
  lowest_price REAL,
  lowest_price_meta_json TEXT,
  source_of_truth TEXT NOT NULL DEFAULT 'stub',
  fetched_at TEXT NOT NULL,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  merchant_id TEXT,
  source_id TEXT,
  source_store_name TEXT,
  product_id TEXT,
  product_slug TEXT,
  title TEXT,
  price REAL,
  currency TEXT,
  status TEXT,
  effective_status TEXT,
  freshness_status TEXT,
  url TEXT,
  stock_count INTEGER,
  platform TEXT,
  product_type TEXT,
  ldxp_goods_key TEXT,
  captured_at TEXT,
  fetched_at TEXT NOT NULL,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_offers_merchant ON offers(merchant_id);
CREATE INDEX IF NOT EXISTS idx_offers_source_id ON offers(source_id);
CREATE INDEX IF NOT EXISTS idx_offers_product ON offers(product_id);
CREATE INDEX IF NOT EXISTS idx_offers_platform ON offers(platform);
CREATE INDEX IF NOT EXISTS idx_offers_price ON offers(price);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
CREATE INDEX IF NOT EXISTS idx_offers_title ON offers(title);
CREATE INDEX IF NOT EXISTS idx_offers_ldxp_goods_key ON offers(ldxp_goods_key);

CREATE TABLE IF NOT EXISTS shop_products (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  merchant_id TEXT,
  source_shop_token TEXT NOT NULL,
  source_goods_key TEXT NOT NULL,
  source_url TEXT,
  shop_name TEXT,
  title TEXT NOT NULL,
  price REAL,
  market_price REAL,
  currency TEXT DEFAULT 'CNY',
  goods_type TEXT,
  category_id INTEGER,
  category_name TEXT,
  stock INTEGER,
  image TEXT,
  description_text TEXT,
  description_html TEXT,
  fetched_at TEXT NOT NULL,
  raw_json TEXT,
  UNIQUE (source, source_shop_token, source_goods_key)
);

CREATE INDEX IF NOT EXISTS idx_shop_products_merchant ON shop_products(merchant_id);
CREATE INDEX IF NOT EXISTS idx_shop_products_title ON shop_products(title);
CREATE INDEX IF NOT EXISTS idx_shop_products_price ON shop_products(price);
CREATE INDEX IF NOT EXISTS idx_shop_products_goods_key ON shop_products(source_goods_key);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (target_type, target_id)
);

CREATE TABLE IF NOT EXISTS recent_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  title_snapshot TEXT,
  viewed_at TEXT NOT NULL,
  UNIQUE (target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_recent_viewed_at ON recent_views(viewed_at DESC);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT,
  current INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  message TEXT,
  error_code TEXT,
  error_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`

/** Schema version 2 — drop PriceAI offers/catalog; shop_products is price source. */
export const SCHEMA_V2_SQL = `
DROP TABLE IF EXISTS offers;
DROP TABLE IF EXISTS catalog_products;
DELETE FROM favorites WHERE target_type = 'offer';
`

/** Schema version 3 — app-side health for ldxp scrape. */
export const SCHEMA_V3_SQL = `
ALTER TABLE merchants ADD COLUMN app_health_status TEXT;
ALTER TABLE merchants ADD COLUMN app_health_at TEXT;
ALTER TABLE merchants ADD COLUMN app_health_message TEXT;
`

/** Schema version 6 — local blocklist for search. */
export const SCHEMA_V6_SQL = `
CREATE TABLE IF NOT EXISTS blocked_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  title_snapshot TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_blocked_targets_type ON blocked_targets(target_type);
`

/** Schema version 7 — product title search index fields (norm + tokens). */
export const SCHEMA_V7_SQL = `
CREATE INDEX IF NOT EXISTS idx_shop_products_title_norm ON shop_products(title_norm);
`

/** Schema version 11 — proxy nodes proven unusable for a platform (expiring). */
export const SCHEMA_V11_SQL = `
CREATE TABLE IF NOT EXISTS platform_bad_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (platform_id, node_name)
);
CREATE INDEX IF NOT EXISTS idx_platform_bad_nodes_platform ON platform_bad_nodes(platform_id);
`

export const REQUIRED_TABLES = [
  'schema_migrations',
  'merchants',
  'shop_products',
  'favorites',
  'recent_views',
  'sync_jobs',
  'app_settings',
  'blocked_targets',
  'platform_bad_nodes'
] as const
