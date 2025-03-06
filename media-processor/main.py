#!/usr/bin/env python3
import asyncio
import argparse
import os
import logging
import colorlog
from dotenv import load_dotenv

from stream_hook import StreamHook

# Load environment variables
load_dotenv()

def setup_logging(log_level):
    """Set up colorful logging"""
    handler = colorlog.StreamHandler()
    handler.setFormatter(colorlog.ColoredFormatter(
        '%(log_color)s%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        log_colors={
            'DEBUG': 'cyan',
            'INFO': 'green',
            'WARNING': 'yellow',
            'ERROR': 'red',
            'CRITICAL': 'red,bg_white',
        }
    ))
    
    logger = logging.getLogger()
    logger.setLevel(getattr(logging, log_level))
    logger.addHandler(handler)
    
    # Set aiortc logging to WARNING to reduce noise
    logging.getLogger('aiortc').setLevel(logging.WARNING)
    logging.getLogger('aioice').setLevel(logging.WARNING)
    
    return logger

async def main():
    """Main entry point for the media processor service"""
    parser = argparse.ArgumentParser(description="MediaSoup Stream Processor")
    parser.add_argument("--server", default=os.getenv("SERVER_URL", "http://localhost:3001"), 
                        help="Stream server URL")
    parser.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO"), 
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"], 
                        help="Logging level")
    parser.add_argument("--frames-dir", default=os.getenv("SAVE_FRAMES_DIR", "./frames"),
                        help="Directory to save frames")
    parser.add_argument("--openai-key", default=os.getenv("OPENAI_API_KEY"),
                        help="OpenAI API key for GPT-4o")
    parser.add_argument("--gpt-model", default=os.getenv("GPT_MODEL", "gpt-4o"),
                        help="GPT model to use")
    parser.add_argument("--analysis-interval", type=int, 
                        default=int(os.getenv("FRAME_ANALYSIS_INTERVAL", "5")),
                        help="Analyze every X frames")
    parser.add_argument("--max-history", type=int, 
                        default=int(os.getenv("MAX_FRAME_HISTORY", "10")),
                        help="Number of frames to keep in history")
    parser.add_argument("--auto-detect", action="store_true", 
                        default=os.getenv("AUTO_DETECT", "true").lower() in ("true", "1", "yes", "y"),
                        help="Automatically send all analysis results to chat")
    
    args = parser.parse_args()
    
    # Setup logging
    logger = setup_logging(args.log_level)
    logger.info(f"Starting Media Processor Service")
    
    # Check for OpenAI API key
    if not args.openai_key:
        logger.warning("No OpenAI API key provided. GPT-4o analysis will be disabled.")
        logger.warning("Set the OPENAI_API_KEY environment variable or use --openai-key")
    
    # Create frames directory if it doesn't exist
    os.makedirs(args.frames_dir, exist_ok=True)
    
    # Create implementation_plan.md in the root directory if it doesn't exist
    implementation_plan_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "implementation_plan.md")
    if not os.path.exists(implementation_plan_path):
        logger.warning(f"Implementation plan not found at {implementation_plan_path}")
        logger.warning("Create this file to provide context for GPT-4o analysis")
    
    # Create and start the stream hook
    hook = StreamHook(
        server_url=args.server,
        frames_dir=args.frames_dir,
        openai_api_key=args.openai_key,
        gpt_model=args.gpt_model,
        frame_analysis_interval=args.analysis_interval,
        max_frame_history=args.max_history,
        auto_detect=args.auto_detect
    )
    
    try:
        await hook.start()
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received")
    except Exception as e:
        logger.error(f"Error in main loop: {e}", exc_info=True)
    finally:
        await hook.stop()

if __name__ == "__main__":
    asyncio.run(main()) 