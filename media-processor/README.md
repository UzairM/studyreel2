# Media Processor Service

A Python service that connects to the MediaSoup stream server, consumes video streams, and processes them using GPT-4o for OCR and event detection based on the StudyReel implementation plan.

## Features

- Connects to MediaSoup server via Socket.IO
- Consumes video streams using WebRTC
- Processes video frames with GPT-4o for:
  - OCR (text extraction)
  - Application detection
  - Student activity monitoring
  - Event detection
  - Anti-pattern identification
- **Auto-detection**: Automatically sends all analysis results to the stream chat
- Sends processed data back to the server
- Monitors chat messages and responds to commands

## Setup

1. Create a virtual environment:
   ```
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

2. Install dependencies:
   ```
   pip install -r requirements.txt
   ```

3. Create a `.env` file with your configuration:
   ```
   SERVER_URL=http://localhost:3001
   LOG_LEVEL=INFO
   OPENAI_API_KEY=your_api_key_here
   GPT_MODEL=gpt-4o
   FRAME_ANALYSIS_INTERVAL=5
   MAX_FRAME_HISTORY=10
   AUTO_DETECT=true
   ```

4. Make sure the `implementation_plan.md` file exists in the parent directory or in the media-processor directory.

## Usage

### Windows

Run the service using the batch file:

```
run.bat
```

Or with custom parameters:

```
run.bat --server http://localhost:3001 --log-level DEBUG --openai-key your_api_key_here --auto-detect
```

### Manual Start

Start the service:

```
python main.py
```

Or with custom parameters:

```
python main.py --server http://localhost:3001 --log-level DEBUG --openai-key your_api_key_here --auto-detect
```

## Available Commands

When the service is running, you can use these commands in the stream chat:

- `!stats` - Show stream statistics
- `!analyze` - Show recent events detected
- `!snapshot` - Take a snapshot of the current frame
- `!auto` - Toggle auto-detection on/off
- `!help` - Show available commands

## How It Works

1. The service connects to your MediaSoup server
2. It discovers existing streams or listens for new ones
3. For each video stream, it creates a WebRTC consumer
4. Video frames are sent to GPT-4o for analysis at regular intervals
5. GPT-4o performs OCR and event detection based on the implementation plan
6. Results are automatically sent to the stream chat (if auto-detection is enabled)

## Auto-Detection

The service automatically sends all analysis results to the stream chat, including:

- OCR text extracted from the screen
- Detected application
- Activity status (active/inactive)
- Events detected
- Anti-patterns identified
- Speed bumps detected

You can toggle auto-detection on/off using the `!auto` command in the stream chat.

## Extending

You can extend this service by:

1. Modifying the GPT-4o prompts in `gpt_analyzer.py`
2. Adding new commands in `stream_hook.py`
3. Enhancing the implementation plan to detect more events 