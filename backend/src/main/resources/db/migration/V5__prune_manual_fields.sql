UPDATE api_data_row AS row
SET data_json = COALESCE((
  SELECT jsonb_object_agg(entry.key, entry.value)
  FROM jsonb_each(row.data_json) AS entry
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(config.manual_schema) AS field
    WHERE field->>'name' = entry.key
  )
), '{}'::jsonb)
FROM api_config AS config
WHERE row.api_id = config.id AND config.data_mode = 'MANUAL';
