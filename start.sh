#!/bin/bash
# Start script for Render deployment

echo "Starting TTS API server..."
echo "PORT: $PORT"

# Use gunicorn for production
exec gunicorn --bind 0.0.0.0:$PORT --workers 1 --timeout 120 --preload main:app