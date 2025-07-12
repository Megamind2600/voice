# Educational Text-to-Speech API for YouTube Shorts

## Overview

This is a Flask-based web application that provides an educational text-to-speech (TTS) API service optimized for YouTube Shorts content creation. The application converts educational text input into clear, well-pronounced audio files using Google Text-to-Speech (gTTS) and serves them via a REST API. It includes a web interface for testing the TTS functionality with support for multiple languages, adjustable speech speeds, and educational mode for clearer pronunciation.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Backend Architecture
- **Framework**: Flask (Python web framework)
- **TTS Engine**: Google Text-to-Speech (gTTS) library
- **Server**: Development server (Flask's built-in server)
- **Language Support**: Multi-language support through gTTS language detection

### Frontend Architecture
- **Template Engine**: Jinja2 (Flask's default templating)
- **UI Framework**: Bootstrap (dark theme via CDN)
- **Icons**: Feather Icons
- **Client-side**: HTML forms with JavaScript for API interaction

## Key Components

### Core Application (`app.py`)
- **Flask Application**: Main application instance with session management
- **TTS Endpoint**: `/speak` POST endpoint for educational text-to-speech conversion
- **Educational Features**: Speech speed control (slow/normal/fast) and educational mode for clearer pronunciation
- **Web Interface**: `/` GET endpoint serving the YouTube Shorts-optimized test page
- **Language Support**: Integration with gTTS supported languages (default: English)
- **Logging**: Comprehensive logging for debugging and monitoring

### Application Runner (`main.py`)
- Simple entry point for running the Flask application
- Configured for development mode with debug enabled
- Bound to all interfaces (0.0.0.0) on port 5000

### Web Interface (`templates/index.html`)
- Bootstrap-based responsive UI
- Form-based interaction for TTS requests
- Language selection dropdown
- Audio playback capabilities

## Data Flow

1. **User Input**: User enters text and selects language via web form
2. **API Request**: Frontend sends POST request to `/speak` endpoint with JSON payload
3. **TTS Processing**: gTTS library converts text to audio file
4. **File Handling**: Temporary audio file creation and management
5. **Response**: Audio file served back to client or error message returned

## External Dependencies

### Core Libraries
- **Flask**: Web framework for API and web interface
- **gTTS**: Google Text-to-Speech library for audio generation
- **tempfile**: Python standard library for temporary file handling
- **uuid**: Unique identifier generation
- **logging**: Application logging and debugging

### Frontend Dependencies (CDN)
- **Bootstrap**: UI framework (dark theme variant)
- **Feather Icons**: Icon library for UI elements

## Deployment Strategy

### Development Setup
- Uses Flask's built-in development server
- Debug mode enabled for development
- Environment-based configuration for session secrets
- Logging configured for development debugging

### Configuration
- **Session Secret**: Environment variable `SESSION_SECRET` with fallback
- **Host Binding**: Configured for all interfaces (0.0.0.0)
- **Port**: Default port 5000
- **Debug Mode**: Enabled for development

### File Structure
```
/
├── app.py              # Main Flask application
├── main.py             # Application entry point
└── templates/
    └── index.html      # Web interface template
```

### Security Considerations
- Session secret key configuration
- Request validation for JSON payloads
- Input sanitization for TTS processing
- Error handling and logging for security monitoring

### Scalability Notes
- Currently uses temporary file storage for audio files
- Single-threaded development server (not production-ready)
- No persistent storage or caching mechanisms
- No authentication or rate limiting implemented