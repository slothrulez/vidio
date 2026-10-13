UPDATE vidio_projects
SET data = jsonb_set(data, '{language}', '"english"'::jsonb)
WHERE data->>'language' IS DISTINCT FROM 'english';
