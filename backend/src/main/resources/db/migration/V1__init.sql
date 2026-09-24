CREATE TABLE datasource (
  id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, db_type VARCHAR(30) NOT NULL,
  jdbc_url TEXT NOT NULL, driver_class VARCHAR(200), username VARCHAR(200) NOT NULL,
  password_enc TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE api_config (
  id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, code VARCHAR(100) NOT NULL UNIQUE,
  path VARCHAR(300) NOT NULL, http_method VARCHAR(10) NOT NULL DEFAULT 'GET',
  data_mode VARCHAR(20) NOT NULL CHECK (data_mode IN ('REALTIME','SNAPSHOT','MANUAL')),
  datasource_id BIGINT REFERENCES datasource(id), sql_text TEXT,
  param_schema JSONB NOT NULL DEFAULT '[]', manual_schema JSONB NOT NULL DEFAULT '[]',
  filter_fields JSONB NOT NULL DEFAULT '[]', row_key_fields JSONB NOT NULL DEFAULT '[]',
  sync_cron VARCHAR(100), allow_empty_sync BOOLEAN NOT NULL DEFAULT FALSE,
  timeout_seconds INTEGER NOT NULL DEFAULT 10, max_rows INTEGER NOT NULL DEFAULT 10000,
  enabled BOOLEAN NOT NULL DEFAULT FALSE, last_sync_at TIMESTAMP,
  last_sync_status VARCHAR(20), last_sync_count INTEGER, last_sync_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(path, http_method)
);
CREATE TABLE api_data_row (
  id BIGSERIAL PRIMARY KEY, api_id BIGINT NOT NULL REFERENCES api_config(id) ON DELETE CASCADE,
  row_key VARCHAR(64) NOT NULL, data_json JSONB NOT NULL, source_order INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(api_id, row_key)
);
CREATE INDEX idx_api_data_row_api ON api_data_row(api_id);
CREATE TABLE api_row_sort (
  api_id BIGINT NOT NULL REFERENCES api_config(id) ON DELETE CASCADE,
  row_key VARCHAR(64) NOT NULL, sort_no INTEGER NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(api_id, row_key)
);
CREATE TABLE api_request_log (
  id BIGSERIAL PRIMARY KEY, request_id VARCHAR(64) NOT NULL, api_id BIGINT,
  request_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, elapsed_ms INTEGER,
  row_count INTEGER, success BOOLEAN, error_message TEXT, data_source VARCHAR(20)
);
CREATE INDEX idx_api_request_log_time ON api_request_log(request_time DESC);
