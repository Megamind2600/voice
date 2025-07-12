# Deployment Guide for TTS API

## Files for Render Deployment

This project includes several files for deployment on Render:

### 1. `requirements_render.txt` 
Copy this file to `requirements.txt` in your Render deployment:
```
Flask>=3.1.1
gTTS>=2.5.4
gunicorn>=23.0.0
```

### 2. `render.yaml` (Optional - for Infrastructure as Code)
Use this for automatic deployment setup.

### 3. `Procfile` (Alternative startup method)
Contains the startup command for the web service.

### 4. `start.sh` (Custom startup script)
Executable script with detailed startup configuration.

## Render Deployment Steps

1. **Create a new Web Service** on Render
2. **Connect your GitHub repository**
3. **Set the following configuration:**
   - **Environment**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn --bind 0.0.0.0:$PORT --workers 1 --timeout 120 main:app`
   - **Instance Type**: Free tier is sufficient for testing

4. **Environment Variables:**
   - `SESSION_SECRET`: Generate a random secret key
   - `PORT`: This is automatically set by Render

5. **Deploy the service**

## Troubleshooting

### "Application exited early" Error
This typically means:
1. Missing dependencies in requirements.txt
2. Incorrect start command
3. Port binding issues
4. Python version mismatch

### Solutions:
- Ensure all dependencies are listed in requirements.txt
- Use the exact start command provided above
- Make sure main.py uses `os.environ.get('PORT', 5000)`
- Verify Python 3.11+ compatibility

## Testing the Deployment
Once deployed, test the API by:
1. Visiting the web interface at your Render URL
2. Testing the `/speak` endpoint with a POST request
3. Checking the logs for any errors

## Manual Requirements.txt Setup
Since requirements.txt cannot be edited directly in this environment, manually create it on Render with:
```
Flask>=3.1.1
gTTS>=2.5.4
gunicorn>=23.0.0
```