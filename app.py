import os
import uuid
import logging
import tempfile
from flask import Flask, request, jsonify, send_file, render_template
from gtts import gTTS
from gtts.lang import tts_langs
import json

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create Flask app
app = Flask(__name__)
app.secret_key = os.environ.get("SESSION_SECRET", "dev-secret-key")

# Get supported languages from gTTS
SUPPORTED_LANGUAGES = tts_langs()

@app.route('/')
def index():
    """Render the test page for the TTS API"""
    return render_template('index.html')

@app.route('/speak', methods=['POST'])
def speak():
    """
    Text-to-speech conversion endpoint
    
    Expected JSON payload:
    {
        "text": "Text to convert to speech (required)",
        "lang": "Language code (optional, defaults to 'hi')"
    }
    
    Returns:
        MP3 audio file or JSON error message
    """
    try:
        # Log incoming request
        logger.info(f"Received TTS request from {request.remote_addr}")
        
        # Validate content type
        if not request.is_json:
            logger.warning("Request content type is not JSON")
            return jsonify({
                "error": "Content-Type must be application/json",
                "message": "Please send JSON data in the request body"
            }), 400
        
        # Parse JSON data
        try:
            data = request.get_json()
            if data is None:
                raise ValueError("No JSON data provided")
        except (json.JSONDecodeError, ValueError) as e:
            logger.error(f"JSON parsing error: {str(e)}")
            return jsonify({
                "error": "Invalid JSON",
                "message": "Please provide valid JSON data"
            }), 400
        
        # Validate required 'text' field
        if 'text' not in data:
            logger.warning("Missing 'text' field in request")
            return jsonify({
                "error": "Missing required field",
                "message": "The 'text' field is required"
            }), 400
        
        text = data['text']
        if not text or not text.strip():
            logger.warning("Empty text provided")
            return jsonify({
                "error": "Empty text",
                "message": "The 'text' field cannot be empty"
            }), 400
        
        # Get language code (default to 'hi' for Hindi)
        lang = data.get('lang', 'hi')
        
        # Validate language code
        if lang not in SUPPORTED_LANGUAGES:
            logger.warning(f"Unsupported language code: {lang}")
            return jsonify({
                "error": "Unsupported language",
                "message": f"Language code '{lang}' is not supported. Supported languages: {list(SUPPORTED_LANGUAGES.keys())}"
            }), 400
        
        # Log the conversion details
        logger.info(f"Converting text to speech - Language: {lang}, Text length: {len(text)}")
        
        # Generate unique filename
        audio_id = str(uuid.uuid4())
        temp_dir = tempfile.gettempdir()
        audio_filename = f"{audio_id}.mp3"
        audio_path = os.path.join(temp_dir, audio_filename)
        
        try:
            # Create gTTS object and save to file
            tts = gTTS(text=text.strip(), lang=lang, slow=False)
            tts.save(audio_path)
            logger.info(f"Audio file created successfully: {audio_path}")
            
            # Return the audio file
            return send_file(
                audio_path,
                mimetype='audio/mpeg',
                as_attachment=True,
                download_name=f"speech_{audio_id}.mp3"
            )
            
        except Exception as e:
            logger.error(f"gTTS conversion error: {str(e)}")
            # Clean up file if it was created
            if os.path.exists(audio_path):
                try:
                    os.remove(audio_path)
                except:
                    pass
            return jsonify({
                "error": "Text-to-speech conversion failed",
                "message": f"Unable to convert text to speech: {str(e)}"
            }), 500
            
    except Exception as e:
        logger.error(f"Unexpected error in /speak endpoint: {str(e)}")
        return jsonify({
            "error": "Internal server error",
            "message": "An unexpected error occurred while processing your request"
        }), 500

@app.route('/languages', methods=['GET'])
def get_languages():
    """Get list of supported languages"""
    try:
        logger.info("Fetching supported languages")
        return jsonify({
            "supported_languages": SUPPORTED_LANGUAGES,
            "total_count": len(SUPPORTED_LANGUAGES)
        })
    except Exception as e:
        logger.error(f"Error fetching languages: {str(e)}")
        return jsonify({
            "error": "Unable to fetch languages",
            "message": str(e)
        }), 500

@app.errorhandler(404)
def not_found(error):
    """Handle 404 errors"""
    return jsonify({
        "error": "Not found",
        "message": "The requested resource was not found"
    }), 404

@app.errorhandler(405)
def method_not_allowed(error):
    """Handle 405 errors"""
    return jsonify({
        "error": "Method not allowed",
        "message": "The requested method is not allowed for this resource"
    }), 405

@app.errorhandler(500)
def internal_error(error):
    """Handle 500 errors"""
    logger.error(f"Internal server error: {str(error)}")
    return jsonify({
        "error": "Internal server error",
        "message": "An unexpected error occurred"
    }), 500

if __name__ == '__main__':
    logger.info("Starting Flask TTS API server on port 5000")
    app.run(host='0.0.0.0', port=5000, debug=True)
