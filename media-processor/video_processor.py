import cv2
import numpy as np
import logging
import os
import time
import asyncio
from datetime import datetime
from typing import Dict, Any, Optional, Callable, List
import threading
import json

from gpt_analyzer import GPTAnalyzer

logger = logging.getLogger(__name__)

class VideoProcessor:
    def __init__(
        self, 
        stream_id: str, 
        frames_dir: str, 
        on_processed_frame: Optional[Callable] = None,
        openai_api_key: Optional[str] = None,
        gpt_model: str = "gpt-4o",
        frame_analysis_interval: int = 5,
        max_frame_history: int = 10
    ):
        self.stream_id = stream_id
        self.frames_dir = frames_dir
        self.on_processed_frame = on_processed_frame
        
        # Create frames directory
        os.makedirs(frames_dir, exist_ok=True)
        
        # Stats
        self.frames_processed = 0
        self.processing_times = []
        self.last_frame = None
        self.last_frame_time = 0
        self.fps = 0
        
        # GPT Analyzer
        self.gpt_analyzer = None
        if openai_api_key:
            self.gpt_analyzer = GPTAnalyzer(
                api_key=openai_api_key,
                model=gpt_model,
                analysis_interval=frame_analysis_interval,
                max_history=max_frame_history
            )
        else:
            logger.warning("No OpenAI API key provided, GPT analysis will be disabled")
        
        # Processing lock to avoid processing frames too quickly
        self.processing_lock = asyncio.Lock()
        
        # Event history
        self.events = []
        
        logger.info(f"Video processor initialized for stream {stream_id}")
        
    def process_frame(self, frame: np.ndarray, metadata: Dict[str, Any]):
        """Process a video frame"""
        start_time = time.time()
        
        # Store the frame
        self.last_frame = frame.copy()
        self.last_frame_time = time.time()
        
        # Update stats
        self.frames_processed += 1
        
        # Skip some frames to avoid overloading
        if self.frames_processed % 5 != 0:
            return
            
        # Process the frame in a separate task to avoid blocking
        asyncio.create_task(self._process_frame_async(frame, metadata))
        
    async def _process_frame_async(self, frame: np.ndarray, metadata: Dict[str, Any]):
        """Process the frame asynchronously"""
        try:
            # Add stream ID to metadata
            metadata['stream_id'] = self.stream_id
            
            # Basic processing
            processed_frame = frame.copy()
            
            # Add timestamp
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            cv2.putText(
                processed_frame,
                timestamp,
                (10, 30),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (255, 255, 255),
                2
            )
            
            # Add stream ID
            cv2.putText(
                processed_frame,
                f"Stream: {self.stream_id}",
                (10, 60),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (255, 255, 255),
                2
            )
            
            # Analyze with GPT-4o if available
            analysis_result = {"analyzed": False}
            if self.gpt_analyzer:
                analysis_result = await self.gpt_analyzer.analyze_frame(frame, metadata)
                
                # If analysis was performed, add info to the frame
                if analysis_result.get("analyzed", False):
                    # Add OCR text indicator
                    if "ocr_text" in analysis_result and analysis_result["ocr_text"]:
                        ocr_text = analysis_result["ocr_text"]
                        # Truncate if too long
                        if len(ocr_text) > 50:
                            ocr_text = ocr_text[:47] + "..."
                            
                        cv2.putText(
                            processed_frame,
                            f"OCR: {ocr_text}",
                            (10, 90),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.6,
                            (255, 255, 255),
                            1
                        )
                    
                    # Add app detection
                    if "app_detected" in analysis_result and analysis_result["app_detected"]:
                        cv2.putText(
                            processed_frame,
                            f"App: {analysis_result['app_detected']}",
                            (10, 120),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.6,
                            (255, 255, 255),
                            1
                        )
                    
                    # Add activity status
                    if "activity_status" in analysis_result:
                        status_color = (0, 255, 0) if analysis_result["activity_status"] == "active" else (0, 0, 255)
                        cv2.putText(
                            processed_frame,
                            f"Status: {analysis_result['activity_status']}",
                            (10, 150),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.6,
                            status_color,
                            1
                        )
                    
                    # Add events
                    if "events" in analysis_result and analysis_result["events"]:
                        y_pos = 180
                        for i, event in enumerate(analysis_result["events"][:3]):  # Show up to 3 events
                            cv2.putText(
                                processed_frame,
                                f"Event: {event.get('type', 'unknown')} ({event.get('confidence', 0):.2f})",
                                (10, y_pos),
                                cv2.FONT_HERSHEY_SIMPLEX,
                                0.6,
                                (0, 255, 255),
                                1
                            )
                            y_pos += 30
                            
                        # Store events
                        for event in analysis_result["events"]:
                            event["timestamp"] = datetime.now().isoformat()
                            self.events.append(event)
                            
                        # Keep only recent events
                        if len(self.events) > 50:
                            self.events = self.events[-50:]
            
            # Calculate processing time
            processing_time = time.time() - self.last_frame_time
            self.processing_times.append(processing_time)
            if len(self.processing_times) > 100:
                self.processing_times.pop(0)
                
            # Calculate FPS
            if self.processing_times:
                avg_time = sum(self.processing_times) / len(self.processing_times)
                self.fps = 1.0 / avg_time if avg_time > 0 else 0
                
            # Call the callback with the processed frame info
            if self.on_processed_frame:
                frame_info = {
                    'stream_id': self.stream_id,
                    'timestamp': time.time(),
                    'fps': self.fps,
                    'frames': self.frames_processed,
                    'analysis': analysis_result
                }
                self.on_processed_frame(self.stream_id, frame_info)
                
        except Exception as e:
            logger.error(f"Error processing frame: {e}", exc_info=True)
            
    async def save_snapshot(self) -> Optional[str]:
        """Save a snapshot of the current frame"""
        if self.last_frame is None:
            logger.warning("No frame available for snapshot")
            return None
            
        try:
            # Create filename with timestamp
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = os.path.join(self.frames_dir, f"snapshot_{timestamp}.jpg")
            
            # Save the frame
            cv2.imwrite(filename, self.last_frame)
            logger.info(f"Snapshot saved to {filename}")
            
            return filename
        except Exception as e:
            logger.error(f"Error saving snapshot: {e}", exc_info=True)
            return None
            
    def get_stats(self) -> Dict[str, Any]:
        """Get processor stats"""
        stats = {
            'frames': self.frames_processed,
            'fps': self.fps,
            'events_detected': len(self.events)
        }
        
        # Add GPT analyzer stats if available
        if self.gpt_analyzer:
            gpt_stats = self.gpt_analyzer.get_stats()
            stats.update({
                'frames_analyzed': gpt_stats['frames_analyzed'],
                'gpt_events_detected': gpt_stats['events_detected']
            })
            
        return stats
        
    def get_events(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get recent events"""
        return self.events[-limit:] if self.events else []
        
    def close(self):
        """Clean up resources"""
        logger.info(f"Closing video processor for stream {self.stream_id}")
        # Nothing specific to clean up 