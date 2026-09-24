ALTER TABLE api_config
  ADD COLUMN allowed_user_agents JSONB NOT NULL DEFAULT '[]';
